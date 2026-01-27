package handler

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/middleware"
)

// GetSession returns a single session
func (h *Handler) GetSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	session, err := h.sessionService.GetSession(r.Context(), sessionID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Session not found")
		return
	}

	h.JSON(w, http.StatusOK, session)
}

// UpdateSession updates a session
func (h *Handler) UpdateSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	var req struct {
		Name        string  `json:"name"`
		DisplayName *string `json:"displayName"`
		Status      string  `json:"status"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	session, err := h.sessionService.UpdateSession(r.Context(), sessionID, req.Name, req.DisplayName, req.Status)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update session")
		return
	}

	h.JSON(w, http.StatusOK, session)
}

// DeleteSession initiates async deletion of a session
func (h *Handler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)

	if err := h.sessionService.DeleteSession(ctx, projectID, sessionID, h.jobQueue); err != nil {
		if strings.Contains(err.Error(), "not found") {
			h.Error(w, http.StatusNotFound, "Session not found")
			return
		}
		h.Error(w, http.StatusInternalServerError, "Failed to initiate session deletion")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ListMessages returns messages for a session by querying the container.
func (h *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)
	sessionID := chi.URLParam(r, "sessionId")

	messages, err := h.chatService.GetMessages(ctx, projectID, sessionID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"messages": messages})
}

// ListSessionsByWorkspace returns sessions for a workspace.
// Query params:
//   - includeClosed: if "true", include sessions with commitStatus = "completed" (default: false)
func (h *Handler) ListSessionsByWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")
	includeClosed := r.URL.Query().Get("includeClosed") == "true"

	sessions, err := h.sessionService.ListSessionsByWorkspace(r.Context(), workspaceID, includeClosed)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list sessions")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// CommitSession initiates async commit of a session
func (h *Handler) CommitSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)

	if err := h.sessionService.CommitSession(ctx, projectID, sessionID, h.jobQueue); err != nil {
		if strings.Contains(err.Error(), "not found") {
			h.Error(w, http.StatusNotFound, "Session not found")
			return
		}
		if strings.Contains(err.Error(), "already in progress") {
			h.Error(w, http.StatusConflict, err.Error())
			return
		}
		h.Error(w, http.StatusInternalServerError, "Failed to initiate session commit")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// NOTE: CreateSession was removed - sessions are now created implicitly via /api/projects/{projectId}/chat
