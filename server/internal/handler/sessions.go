package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/anthropics/octobot/server/internal/middleware"
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
		Name   string `json:"name"`
		Status string `json:"status"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	session, err := h.sessionService.UpdateSession(r.Context(), sessionID, req.Name, req.Status)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update session")
		return
	}

	h.JSON(w, http.StatusOK, session)
}

// DeleteSession deletes a session
func (h *Handler) DeleteSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	ctx := r.Context()

	if err := h.sessionService.DeleteSession(ctx, sessionID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete session")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// GetSessionFiles returns files for a session
func (h *Handler) GetSessionFiles(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement - this will use git service to get file diffs
	h.JSON(w, http.StatusOK, map[string]any{"files": []any{}})
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

// ListSessionsByWorkspace returns all sessions for a workspace
func (h *Handler) ListSessionsByWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	sessions, err := h.sessionService.ListSessionsByWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list sessions")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// NOTE: CreateSession was removed - sessions are now created implicitly via /api/projects/{projectId}/chat
