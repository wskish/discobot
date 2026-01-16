package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/obot-platform/octobot/server/internal/middleware"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/service"
)

// ChatRequest represents the request body for the chat endpoint.
// This matches the AI SDK's DefaultChatTransport format.
// The Messages field is kept as raw JSON to pass through to the sandbox
// without requiring the Go server to understand the UIMessage structure.
type ChatRequest struct {
	// ID is the chat/session ID (AI SDK sends this as "id")
	ID string `json:"id"`
	// Messages is the raw UIMessage array - passed through to sandbox as-is
	Messages json.RawMessage `json:"messages"`
	// Trigger indicates the type of request: "submit-message" or "regenerate-message"
	Trigger string `json:"trigger,omitempty"`
	// MessageID is the ID of the message to regenerate (for regenerate-message trigger)
	MessageID string `json:"messageId,omitempty"`
	// WorkspaceID is required for new sessions
	WorkspaceID string `json:"workspaceId,omitempty"`
	// AgentID is required for new sessions
	AgentID string `json:"agentId,omitempty"`
}

// Chat handles AI chat streaming.
// POST /api/chat
// Request body: { id, messages, workspaceId?, agentId?, trigger?, messageId? }
// Response: SSE stream with AI SDK UI message protocol
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)

	// Parse request
	var req ChatRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Validate messages is provided and not empty
	if len(req.Messages) == 0 || string(req.Messages) == "null" {
		h.Error(w, http.StatusBadRequest, "messages array required")
		return
	}

	// id (chat ID) is required - client generates IDs
	if req.ID == "" {
		h.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	sessionID := req.ID

	// Check if session exists
	existingSession, err := h.chatService.GetSessionByID(ctx, sessionID)
	if err == nil {
		// Session exists - validate it belongs to this project
		if existingSession.ProjectID != projectID {
			h.Error(w, http.StatusForbidden, "session does not belong to this project")
			return
		}
		// For existing sessions, validate workspace and agent still belong to project
		if err := h.chatService.ValidateSessionResources(ctx, projectID, existingSession); err != nil {
			h.Error(w, http.StatusForbidden, err.Error())
			return
		}
	} else {
		// Session doesn't exist - create it
		if req.WorkspaceID == "" || req.AgentID == "" {
			h.Error(w, http.StatusBadRequest, "workspaceId and agentId are required for new sessions")
			return
		}

		// NewSession validates that workspace and agent belong to project
		_, err := h.chatService.NewSession(ctx, service.NewSessionRequest{
			SessionID:   sessionID,
			ProjectID:   projectID,
			WorkspaceID: req.WorkspaceID,
			AgentID:     req.AgentID,
			Messages:    req.Messages,
		})
		if err != nil {
			h.Error(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	// Set up SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")

	// Wait for session to reach a terminal state (running, error, or stopped)
	sess, err := h.waitForSessionReady(ctx, sessionID, 60*time.Second)
	if err != nil {
		writeSSEErrorAndDone(w, err.Error())
		return
	}

	// If session is in error or stopped state, attempt to reinitialize
	if sess.Status == model.SessionStatusError || sess.Status == model.SessionStatusStopped {
		log.Printf("[Chat] Session %s is %s, attempting reinitialization", sessionID, sess.Status)

		// Update status to reinitializing
		if _, statusErr := h.sessionService.UpdateStatus(ctx, sessionID, model.SessionStatusReinitializing, nil); statusErr != nil {
			log.Printf("[Chat] Warning: failed to update session status: %v", statusErr)
		}

		// Emit SSE event for status change
		if h.eventBroker != nil {
			if pubErr := h.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusReinitializing); pubErr != nil {
				log.Printf("[Chat] Warning: failed to publish session update event: %v", pubErr)
			}
		}

		// Attempt to reinitialize the session
		if initErr := h.sessionService.Initialize(ctx, sessionID); initErr != nil {
			log.Printf("[Chat] Reinitialization failed for session %s: %v", sessionID, initErr)
			writeSSEErrorAndDone(w, fmt.Sprintf("Session reinitialization failed: %v", initErr))
			return
		}

		log.Printf("[Chat] Session %s reinitialized successfully", sessionID)
	}

	// Send messages to sandbox and get raw SSE stream
	sseCh, err := h.chatService.SendToSandbox(ctx, projectID, sessionID, req.Messages)
	if err != nil {
		writeSSEErrorAndDone(w, err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.Error(w, http.StatusInternalServerError, "Streaming not supported")
		return
	}

	// Pass through raw SSE lines from sandbox
	for line := range sseCh {
		if line.Done {
			// Container sent [DONE] signal
			log.Printf("[Chat] Received [DONE] signal from sandbox")
			_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
			flusher.Flush()
			return
		}
		// Log error events for debugging
		if strings.Contains(line.Data, `"type":"error"`) {
			log.Printf("[Chat] Passing through error event: %s", line.Data)
		}
		// Pass through raw data line without parsing
		_, _ = fmt.Fprintf(w, "data: %s\n\n", line.Data)
		flusher.Flush()
	}

	// Send done signal if channel closed without explicit DONE
	_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

// writeSSEError sends an error SSE event in UIMessage Stream format.
// This is used for Go server-originated errors (not pass-through from sandbox).
func writeSSEError(w http.ResponseWriter, errorText string) {
	data := map[string]string{"type": "error", "errorText": errorText}
	jsonData, err := json.Marshal(data)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", jsonData)
}

// writeSSEErrorAndDone sends an error SSE event followed by the [DONE] signal.
// This ensures the AI SDK properly closes the stream after receiving the error.
func writeSSEErrorAndDone(w http.ResponseWriter, errorText string) {
	writeSSEError(w, errorText)
	_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// waitForSessionReady polls the session status until it reaches a terminal state.
// Terminal states are: running, error, or stopped.
func (h *Handler) waitForSessionReady(ctx context.Context, sessionID string, timeout time.Duration) (*model.Session, error) {
	deadline := time.Now().Add(timeout)

	for {
		sess, err := h.store.GetSessionByID(ctx, sessionID)
		if err != nil {
			return nil, fmt.Errorf("session not found: %w", err)
		}

		// Session is ready when in a terminal state (running, error, or stopped)
		if sess.Status == model.SessionStatusRunning ||
			sess.Status == model.SessionStatusError ||
			sess.Status == model.SessionStatusStopped {
			return sess, nil
		}

		// Check timeout
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timeout waiting for session to be ready (status: %s)", sess.Status)
		}

		// Check context cancellation
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
			// Poll again
		}
	}
}
