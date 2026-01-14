package handler

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/service"
)

// ChatRequest represents the request body for the chat endpoint.
// This matches the AI SDK's useChat format.
type ChatRequest struct {
	ID          string        `json:"id"`          // Session/thread ID (optional for new sessions)
	Messages    []ChatMessage `json:"messages"`    // Message history
	WorkspaceID string        `json:"workspaceId"` // Required for new sessions
	AgentID     string        `json:"agentId"`     // Required for new sessions
}

// ChatMessage represents a message in the chat.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Chat handles AI chat streaming.
// POST /api/chat
// Request body: { id?, messages, workspaceId, agentId }
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

	// Get the latest user message
	var latestUserMessage string
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			latestUserMessage = req.Messages[i].Content
			break
		}
	}

	if latestUserMessage == "" {
		h.Error(w, http.StatusBadRequest, "No user message provided")
		return
	}

	var sessionID string

	// If no session ID provided, create a new session
	if req.ID == "" {
		if req.WorkspaceID == "" || req.AgentID == "" {
			h.Error(w, http.StatusBadRequest, "workspaceId and agentId are required for new sessions")
			return
		}

		newSessionID, err := h.chatService.NewSession(ctx, service.NewSessionRequest{
			ProjectID:   projectID,
			WorkspaceID: req.WorkspaceID,
			AgentID:     req.AgentID,
			Prompt:      latestUserMessage,
		})
		if err != nil {
			h.Error(w, http.StatusBadRequest, err.Error())
			return
		}
		sessionID = newSessionID
	} else {
		// Validate existing session belongs to project
		_, err := h.chatService.GetSession(ctx, projectID, req.ID)
		if err != nil {
			h.Error(w, http.StatusNotFound, err.Error())
			return
		}
		sessionID = req.ID
	}

	// Set up SSE headers (set early so we can send status updates)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx buffering
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")

	// Send the session ID as metadata (for new sessions)
	if req.ID == "" {
		sendSSEEvent(w, "metadata", map[string]string{"sessionId": sessionID})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}

	// Wait for session to be ready (container running)
	sess, err := h.waitForSessionReady(ctx, sessionID, 60*time.Second)
	if err != nil {
		sendSSEEvent(w, "data", map[string]any{"type": "error", "errorText": err.Error()})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return
	}

	// Check if session is in error state
	if sess.Status == model.SessionStatusError {
		errMsg := "Session initialization failed"
		if sess.ErrorMessage != nil {
			errMsg = *sess.ErrorMessage
		}
		sendSSEEvent(w, "data", map[string]any{"type": "error", "errorText": errMsg})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return
	}

	// Send message to container and get event stream
	eventCh, err := h.chatService.SendToContainer(ctx, projectID, sessionID, latestUserMessage)
	if err != nil {
		sendSSEEvent(w, "data", map[string]any{"type": "error", "errorText": err.Error()})
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		h.Error(w, http.StatusInternalServerError, "Streaming not supported")
		return
	}

	// Stream events following AI SDK UI Message Stream Protocol
	for event := range eventCh {
		var data map[string]any

		switch event.Type {
		// Message flow events
		case service.ChatEventStart:
			data = map[string]any{"type": "start", "messageId": event.MessageID}
		case service.ChatEventFinish:
			data = map[string]any{"type": "finish"}
		case service.ChatEventAbort:
			data = map[string]any{"type": "abort", "reason": event.Reason}

		// Text content events
		case service.ChatEventTextStart:
			data = map[string]any{"type": "text-start", "id": event.ID}
		case service.ChatEventTextDelta:
			data = map[string]any{"type": "text-delta", "id": event.ID, "delta": event.Delta}
		case service.ChatEventTextEnd:
			data = map[string]any{"type": "text-end", "id": event.ID}

		// Reasoning events
		case service.ChatEventReasoningStart:
			data = map[string]any{"type": "reasoning-start", "id": event.ID}
		case service.ChatEventReasoningDelta:
			data = map[string]any{"type": "reasoning-delta", "id": event.ID, "delta": event.Delta}
		case service.ChatEventReasoningEnd:
			data = map[string]any{"type": "reasoning-end", "id": event.ID}

		// Tool execution events
		case service.ChatEventToolInputStart:
			data = map[string]any{"type": "tool-input-start", "toolCallId": event.ToolCallID, "toolName": event.ToolName}
		case service.ChatEventToolInputDelta:
			data = map[string]any{"type": "tool-input-delta", "toolCallId": event.ToolCallID, "inputTextDelta": event.Delta}
		case service.ChatEventToolInputAvailable:
			data = map[string]any{"type": "tool-input-available", "toolCallId": event.ToolCallID, "toolName": event.ToolName, "input": event.Input}
		case service.ChatEventToolOutputAvailable:
			data = map[string]any{"type": "tool-output-available", "toolCallId": event.ToolCallID, "output": event.Output}

		// Reference events
		case service.ChatEventSourceURL:
			data = map[string]any{"type": "source-url", "sourceId": event.SourceID, "url": event.URL}
		case service.ChatEventSourceDocument:
			data = map[string]any{"type": "source-document", "sourceId": event.SourceID, "mediaType": event.MediaType, "title": event.Title}
		case service.ChatEventFile:
			data = map[string]any{"type": "file", "url": event.URL, "mediaType": event.MediaType}
			if event.Filename != "" {
				data["filename"] = event.Filename
			}

		// Step events
		case service.ChatEventStartStep:
			data = map[string]any{"type": "start-step"}
		case service.ChatEventFinishStep:
			data = map[string]any{"type": "finish-step"}

		// Error event
		case service.ChatEventError:
			data = map[string]any{"type": "error", "errorText": event.ErrorText}

		default:
			// Unknown event type, skip
			continue
		}

		sendSSEEvent(w, "data", data)
		flusher.Flush()
	}

	// Send done signal
	fmt.Fprintf(w, "data: [DONE]\n\n")
	flusher.Flush()
}

// sendSSEEvent sends an SSE event with JSON data.
func sendSSEEvent(w http.ResponseWriter, eventType string, data any) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, jsonData)
}

// waitForSessionReady polls the session status until it's running or errored.
func (h *Handler) waitForSessionReady(ctx context.Context, sessionID string, timeout time.Duration) (*model.Session, error) {
	deadline := time.Now().Add(timeout)

	for {
		sess, err := h.store.GetSessionByID(ctx, sessionID)
		if err != nil {
			return nil, fmt.Errorf("session not found: %w", err)
		}

		// Session is ready when running or in error state
		if sess.Status == model.SessionStatusRunning || sess.Status == model.SessionStatusError {
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
