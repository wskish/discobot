package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/middleware"
)

// ListProjects returns all projects for the current user
func (h *Handler) ListProjects(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	projects, err := h.projectService.ListProjects(r.Context(), userID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list projects")
		return
	}

	h.JSON(w, http.StatusOK, projects)
}

// CreateProject creates a new project
func (h *Handler) CreateProject(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" {
		h.Error(w, http.StatusBadRequest, "Name is required")
		return
	}

	project, err := h.projectService.CreateProject(r.Context(), userID, req.Name)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create project")
		return
	}

	h.JSON(w, http.StatusCreated, project)
}

// GetProject returns a single project
func (h *Handler) GetProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	project, err := h.projectService.GetProject(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Project not found")
		return
	}

	h.JSON(w, http.StatusOK, project)
}

// UpdateProject updates a project
func (h *Handler) UpdateProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	// Check if user is admin or owner
	userID := middleware.GetUserID(r.Context())
	role, err := h.projectService.GetMemberRole(r.Context(), projectID, userID)
	if err != nil || (role != "owner" && role != "admin") {
		h.Error(w, http.StatusForbidden, "Admin access required")
		return
	}

	var req struct {
		Name string `json:"name"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	project, err := h.projectService.UpdateProject(r.Context(), projectID, req.Name)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update project")
		return
	}

	h.JSON(w, http.StatusOK, project)
}

// DeleteProject deletes a project
func (h *Handler) DeleteProject(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	// Check if user is owner
	userID := middleware.GetUserID(r.Context())
	role, err := h.projectService.GetMemberRole(r.Context(), projectID, userID)
	if err != nil || role != "owner" {
		h.Error(w, http.StatusForbidden, "Owner access required")
		return
	}

	if err := h.projectService.DeleteProject(r.Context(), projectID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete project")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// ListProjectMembers returns project members
func (h *Handler) ListProjectMembers(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	members, err := h.projectService.ListMembers(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list members")
		return
	}

	h.JSON(w, http.StatusOK, members)
}

// RemoveProjectMember removes a member from a project
func (h *Handler) RemoveProjectMember(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")
	targetUserID := chi.URLParam(r, "userId")

	// Check if current user is admin or owner
	userID := middleware.GetUserID(r.Context())
	role, err := h.projectService.GetMemberRole(r.Context(), projectID, userID)
	if err != nil || (role != "owner" && role != "admin") {
		h.Error(w, http.StatusForbidden, "Admin access required")
		return
	}

	// Cannot remove owner
	targetRole, _ := h.projectService.GetMemberRole(r.Context(), projectID, targetUserID)
	if targetRole == "owner" {
		h.Error(w, http.StatusForbidden, "Cannot remove project owner")
		return
	}

	if err := h.projectService.RemoveMember(r.Context(), projectID, targetUserID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to remove member")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// CreateInvitation creates a project invitation
func (h *Handler) CreateInvitation(w http.ResponseWriter, r *http.Request) {
	projectID := chi.URLParam(r, "projectId")

	// Check if user is admin or owner
	userID := middleware.GetUserID(r.Context())
	role, err := h.projectService.GetMemberRole(r.Context(), projectID, userID)
	if err != nil || (role != "owner" && role != "admin") {
		h.Error(w, http.StatusForbidden, "Admin access required")
		return
	}

	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Email == "" {
		h.Error(w, http.StatusBadRequest, "Email is required")
		return
	}
	if req.Role == "" {
		req.Role = "member"
	}

	invitation, err := h.projectService.CreateInvitation(r.Context(), projectID, userID, req.Email, req.Role)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create invitation")
		return
	}

	h.JSON(w, http.StatusCreated, invitation)
}

// AcceptInvitation accepts a project invitation
func (h *Handler) AcceptInvitation(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	userID := middleware.GetUserID(r.Context())

	if err := h.projectService.AcceptInvitation(r.Context(), token, userID); err != nil {
		h.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
