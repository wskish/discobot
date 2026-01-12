package handler

import (
	"net/http"

	"github.com/anthropics/octobot/server/internal/git"
	"github.com/go-chi/chi/v5"
)

// GetWorkspaceGitStatus returns the git status for a workspace
func (h *Handler) GetWorkspaceGitStatus(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	status, err := h.gitService.Status(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get git status: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, status)
}

// FetchWorkspace fetches updates from remote for a workspace
func (h *Handler) FetchWorkspace(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	if err := h.gitService.Fetch(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to fetch: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// CheckoutWorkspace checks out a specific ref in a workspace
func (h *Handler) CheckoutWorkspace(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Ref string `json:"ref"`
	}
	if err := h.DecodeJSON(r, &req); err != nil || req.Ref == "" {
		h.Error(w, http.StatusBadRequest, "ref is required")
		return
	}

	if err := h.gitService.Checkout(r.Context(), workspaceID, req.Ref); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to checkout: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// GetWorkspaceBranches returns all branches for a workspace
func (h *Handler) GetWorkspaceBranches(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	branches, err := h.gitService.Branches(r.Context(), workspaceID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get branches: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"branches": branches})
}

// GetWorkspaceDiff returns the diff for a workspace
func (h *Handler) GetWorkspaceDiff(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	// Parse query params for diff options
	opts := git.DiffOptions{
		Staged:  r.URL.Query().Get("staged") == "true",
		BaseRef: r.URL.Query().Get("base"),
		HeadRef: r.URL.Query().Get("head"),
	}

	if paths := r.URL.Query()["path"]; len(paths) > 0 {
		opts.Paths = paths
	}

	diffs, err := h.gitService.Diff(r.Context(), workspaceID, opts)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get diff: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"diffs": diffs})
}

// GetWorkspaceFileTree returns the file tree for a workspace
func (h *Handler) GetWorkspaceFileTree(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")
	ref := r.URL.Query().Get("ref")

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	entries, err := h.gitService.FileTree(r.Context(), workspaceID, ref)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get file tree: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"files": entries})
}

// GetWorkspaceFileContent returns the content of a file in a workspace
func (h *Handler) GetWorkspaceFileContent(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")
	path := r.URL.Query().Get("path")
	ref := r.URL.Query().Get("ref")

	if path == "" {
		h.Error(w, http.StatusBadRequest, "path is required")
		return
	}

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	content, err := h.gitService.ReadFile(r.Context(), workspaceID, ref, path)
	if err != nil {
		h.Error(w, http.StatusNotFound, "File not found: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{
		"path":    path,
		"ref":     ref,
		"content": string(content),
	})
}

// WriteWorkspaceFile writes content to a file in a workspace
func (h *Handler) WriteWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Path == "" {
		h.Error(w, http.StatusBadRequest, "path is required")
		return
	}

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	if err := h.gitService.WriteFile(r.Context(), workspaceID, req.Path, []byte(req.Content)); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to write file: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// StageWorkspaceFiles stages files for commit
func (h *Handler) StageWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Paths []string `json:"paths"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(req.Paths) == 0 {
		req.Paths = []string{"."} // Stage all by default
	}

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	if err := h.gitService.Stage(r.Context(), workspaceID, req.Paths); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to stage files: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// CommitWorkspace creates a commit in a workspace
func (h *Handler) CommitWorkspace(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	var req struct {
		Message     string `json:"message"`
		AuthorName  string `json:"authorName"`
		AuthorEmail string `json:"authorEmail"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Message == "" {
		h.Error(w, http.StatusBadRequest, "message is required")
		return
	}

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	commit, err := h.gitService.Commit(r.Context(), workspaceID, req.Message, req.AuthorName, req.AuthorEmail)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to commit: "+err.Error())
		return
	}

	h.JSON(w, http.StatusCreated, commit)
}

// GetWorkspaceLog returns commit history for a workspace
func (h *Handler) GetWorkspaceLog(w http.ResponseWriter, r *http.Request) {
	if h.gitService == nil {
		h.Error(w, http.StatusServiceUnavailable, "Git service not configured")
		return
	}

	workspaceID := chi.URLParam(r, "workspaceId")

	// Ensure the workspace repo is set up
	if _, err := h.gitService.EnsureWorkspaceRepo(r.Context(), workspaceID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to initialize workspace: "+err.Error())
		return
	}

	opts := git.LogOptions{
		Ref: r.URL.Query().Get("ref"),
	}

	// Parse limit from query param
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		var limit int
		if _, err := parseIntQuery(limitStr, &limit); err == nil && limit > 0 {
			opts.Limit = limit
		}
	}

	commits, err := h.gitService.Log(r.Context(), workspaceID, opts)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get log: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"commits": commits})
}

// parseIntQuery is a helper to parse int query params
func parseIntQuery(s string, v *int) (bool, error) {
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			return false, nil
		}
		n = n*10 + int(c-'0')
	}
	*v = n
	return true, nil
}
