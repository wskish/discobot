package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/anthropics/octobot/server/internal/middleware"
)

// ListWorkspaces returns all workspaces for a project
func (h *Handler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	workspaces, err := h.workspaceService.ListWorkspaces(r.Context(), projectID)
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

	workspace, err := h.workspaceService.CreateWorkspace(r.Context(), projectID, req.Path, req.SourceType)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create workspace")
		return
	}

	// Enqueue workspace initialization job
	if err := h.jobQueue.EnqueueWorkspaceInit(r.Context(), projectID, workspace.ID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to enqueue workspace initialization")
		return
	}

	h.JSON(w, http.StatusCreated, workspace)
}

// GetWorkspace returns a single workspace
func (h *Handler) GetWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")

	workspace, err := h.workspaceService.GetWorkspaceWithSessions(r.Context(), workspaceID)
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
		Path string `json:"path"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	workspace, err := h.workspaceService.UpdateWorkspace(r.Context(), workspaceID, req.Path)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update workspace")
		return
	}

	h.JSON(w, http.StatusOK, workspace)
}

// DeleteWorkspace deletes a workspace
// Query params:
//   - deleteFiles: if "true", also delete the workspace files from disk
func (h *Handler) DeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "workspaceId")
	deleteFiles := r.URL.Query().Get("deleteFiles") == "true"

	if err := h.workspaceService.DeleteWorkspace(r.Context(), workspaceID, deleteFiles); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete workspace")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
