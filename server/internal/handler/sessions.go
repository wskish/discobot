package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/service"
)

// GetSession returns a single session
func (h *Handler) GetSession(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	session, err := h.sessionService().GetSession(r.Context(), sessionID)
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

	session, err := h.sessionService().UpdateSession(r.Context(), sessionID, req.Name, req.Status)
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

	if err := h.sessionService().DeleteSession(ctx, sessionID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete session")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// sessionService returns a session service (created on demand)
func (h *Handler) sessionService() *service.SessionService {
	return service.NewSessionService(h.store)
}

// GetSessionFiles returns files for a session
func (h *Handler) GetSessionFiles(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement - this will use git service to get file diffs
	h.JSON(w, http.StatusOK, map[string]any{"files": []any{}})
}

// ListMessages returns messages for a session
func (h *Handler) ListMessages(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement - this will use message service
	h.JSON(w, http.StatusOK, map[string]any{"messages": []any{}})
}

// ListSessionsByWorkspace returns all sessions for a workspace
func (h *Handler) ListSessionsByWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	sessions, err := h.sessionService().ListSessionsByWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list sessions")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

// CreateSession creates a new session in a workspace
func (h *Handler) CreateSession(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())
	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Name    string `json:"name"`
		AgentID string `json:"agentId"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" {
		req.Name = "New Session"
	}

	// Validate workspace belongs to this project
	workspace, err := h.store.GetWorkspaceByID(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Workspace not found")
		return
	}
	if workspace.ProjectID != projectID {
		h.Error(w, http.StatusForbidden, "Workspace does not belong to this project")
		return
	}

	// Validate agent belongs to this project (if provided)
	if req.AgentID != "" {
		agent, err := h.store.GetAgentByID(r.Context(), req.AgentID)
		if err != nil {
			h.Error(w, http.StatusNotFound, "Agent not found")
			return
		}
		if agent.ProjectID != projectID {
			h.Error(w, http.StatusForbidden, "Agent does not belong to this project")
			return
		}
	}

	// Create session with initializing status
	session, err := h.sessionService().CreateSession(r.Context(), projectID, workspaceID, req.Name, req.AgentID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create session")
		return
	}

	// Enqueue session initialization job
	if err := h.jobQueue.EnqueueSessionInit(r.Context(), projectID, session.ID, workspaceID, req.AgentID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to enqueue session initialization")
		return
	}

	h.JSON(w, http.StatusCreated, session)
}
