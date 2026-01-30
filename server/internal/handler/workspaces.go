package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/middleware"
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
		Path        string  `json:"path"`
		DisplayName *string `json:"displayName"`
		SourceType  string  `json:"sourceType"`
		Provider    string  `json:"provider"`
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
	if req.Provider == "" {
		req.Provider = "docker"
	}

	workspace, err := h.workspaceService.CreateWorkspace(r.Context(), projectID, req.Path, req.SourceType)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create workspace")
		return
	}

	// Update display name and provider if provided
	if req.DisplayName != nil || req.Provider != "" {
		// Get the model workspace and update it
		modelWorkspace, err := h.store.GetWorkspaceByID(r.Context(), workspace.ID)
		if err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to get workspace for update")
			return
		}
		if req.DisplayName != nil {
			modelWorkspace.DisplayName = req.DisplayName
		}
		if req.Provider != "" {
			modelWorkspace.Provider = req.Provider
		}
		if err := h.store.UpdateWorkspace(r.Context(), modelWorkspace); err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to update workspace")
			return
		}
		// Update the response object
		workspace.DisplayName = req.DisplayName
		workspace.Provider = req.Provider
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

	// Parse raw JSON to detect which fields were sent
	var rawReq map[string]interface{}
	if err := h.DecodeJSON(r, &rawReq); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Get the existing workspace
	workspace, err := h.store.GetWorkspaceByID(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Workspace not found")
		return
	}

	modified := false

	// Update path if provided
	if path, ok := rawReq["path"].(string); ok {
		// UpdateWorkspace in service returns the full workspace, but we need to re-fetch
		// to ensure we have the latest model
		_, err = h.workspaceService.UpdateWorkspace(r.Context(), workspaceID, path)
		if err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to update workspace")
			return
		}
		// Re-fetch to get updated workspace
		workspace, err = h.store.GetWorkspaceByID(r.Context(), workspaceID)
		if err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to get updated workspace")
			return
		}
		modified = true
	}

	// Update display name if the field was sent (even if null to clear it)
	if displayName, ok := rawReq["displayName"]; ok {
		if displayName == nil {
			workspace.DisplayName = nil
		} else if str, ok := displayName.(string); ok {
			workspace.DisplayName = &str
		}
		modified = true
	}

	// Update provider if provided
	if provider, ok := rawReq["provider"].(string); ok {
		workspace.Provider = provider
		modified = true
	}

	// Save if we modified the workspace
	if modified {
		if err := h.store.UpdateWorkspace(r.Context(), workspace); err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to update workspace")
			return
		}
	}

	// Map to service workspace for response
	serviceWorkspace, err := h.workspaceService.GetWorkspace(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get updated workspace")
		return
	}
	h.JSON(w, http.StatusOK, serviceWorkspace)
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

// GetSandboxProviders returns the list of available sandbox providers
func (h *Handler) GetSandboxProviders(w http.ResponseWriter, _ *http.Request) {
	// Check if sandboxProvider is a ProviderProxy that exposes ListProviders
	type providerLister interface {
		ListProviders() []string
	}

	var providers []string
	if pl, ok := h.sandboxProvider.(providerLister); ok {
		providers = pl.ListProviders()
	}

	h.JSON(w, http.StatusOK, map[string]any{"providers": providers})
}
