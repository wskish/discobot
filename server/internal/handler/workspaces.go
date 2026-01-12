package handler

import (
	"log"
	"net/http"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/go-chi/chi/v5"
)

// workspaceService returns a workspace service (created on demand)
func (h *Handler) workspaceService() *service.WorkspaceService {
	return service.NewWorkspaceService(h.store)
}

// sessionService returns a session service (created on demand)
func (h *Handler) sessionService() *service.SessionService {
	return service.NewSessionService(h.store)
}

// ListWorkspaces returns all workspaces for a project
func (h *Handler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	workspaces, err := h.workspaceService().ListWorkspaces(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list workspaces")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"workspaces": workspaces})
}

// CreateWorkspace creates a new workspace
func (h *Handler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req struct {
		Path       string `json:"path"`
		SourceType string `json:"sourceType"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Path == "" {
		h.Error(w, http.StatusBadRequest, "Path is required")
		return
	}
	if req.SourceType == "" {
		req.SourceType = "local"
	}

	workspace, err := h.workspaceService().CreateWorkspace(r.Context(), projectID, req.Path, req.SourceType)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create workspace")
		return
	}

	h.JSON(w, http.StatusCreated, workspace)
}

// GetWorkspace returns a single workspace
func (h *Handler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	workspace, err := h.workspaceService().GetWorkspaceWithSessions(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Workspace not found")
		return
	}

	h.JSON(w, http.StatusOK, workspace)
}

// UpdateWorkspace updates a workspace
func (h *Handler) UpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	workspace, err := h.workspaceService().UpdateWorkspace(r.Context(), workspaceID, req.Name, req.Path)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update workspace")
		return
	}

	h.JSON(w, http.StatusOK, workspace)
}

// DeleteWorkspace deletes a workspace
func (h *Handler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	if err := h.workspaceService().DeleteWorkspace(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete workspace")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
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
		h.Error(w, http.StatusBadRequest, "Name is required")
		return
	}

	// Get workspace to get the path for container mounting
	workspace, err := h.workspaceService().GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Workspace not found")
		return
	}

	session, err := h.sessionService().CreateSession(r.Context(), workspaceID, req.Name, req.AgentID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create session")
		return
	}

	// Enqueue container creation job (processed by dispatcher)
	if h.jobQueue != nil {
		if err := h.jobQueue.EnqueueContainerCreate(r.Context(), session.ID, workspace.Path); err != nil {
			// Log but don't fail the request - container can be created on-demand
			log.Printf("Failed to enqueue container create job for session %s: %v", session.ID, err)
		}
	}

	h.JSON(w, http.StatusCreated, session)
}
