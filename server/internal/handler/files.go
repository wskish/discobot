package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/middleware"
	"github.com/obot-platform/octobot/server/internal/sandbox/sandboxapi"
)

// Suggestion represents an autocomplete suggestion
type Suggestion struct {
	Value string `json:"value"`
	Type  string `json:"type"`
	Valid bool   `json:"valid"` // true if directory contains .git, false otherwise
}

// GetSuggestions returns autocomplete suggestions for directory paths.
// Only works when suggestions are enabled via SUGGESTIONS_ENABLED env var.
// Returns directories containing .git subdirectories.
// GET /api/projects/{projectId}/suggestions?q=/home/user&type=path
func (h *Handler) GetSuggestions(w http.ResponseWriter, r *http.Request) {
	// Only provide suggestions when enabled
	if !h.cfg.SuggestionsEnabled {
		h.JSON(w, http.StatusOK, map[string]any{"suggestions": []Suggestion{}})
		return
	}

	query := r.URL.Query().Get("q")
	suggestionType := r.URL.Query().Get("type")

	// Default to "path" type
	if suggestionType == "" {
		suggestionType = "path"
	}

	if query == "" {
		h.JSON(w, http.StatusOK, map[string]any{"suggestions": []Suggestion{}})
		return
	}

	// Only handle path suggestions for now
	if suggestionType != "path" {
		h.JSON(w, http.StatusOK, map[string]any{"suggestions": []Suggestion{}})
		return
	}

	suggestions := getDirectorySuggestions(query)
	h.JSON(w, http.StatusOK, map[string]any{"suggestions": suggestions})
}

// getDirectorySuggestions returns directory path suggestions with git repositories
func getDirectorySuggestions(query string) []Suggestion {
	// Expand ~ to home directory for searching
	searchPath := query
	if strings.HasPrefix(query, "~") {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return []Suggestion{}
		}
		// Remove ~ and any leading / or \ after it
		remainder := strings.TrimPrefix(query, "~")
		remainder = strings.TrimPrefix(remainder, "/")
		remainder = strings.TrimPrefix(remainder, "\\")

		if remainder == "" {
			searchPath = homeDir
		} else {
			searchPath = filepath.Join(homeDir, remainder)
		}
	}

	// Get the directory to search and the prefix to match
	var searchDir, prefix string

	// Check if the path matches an existing directory
	if info, err := os.Stat(searchPath); err == nil && info.IsDir() {
		// Path is a directory - list its subdirectories
		searchDir = searchPath
		prefix = ""
	} else {
		// Path doesn't match a directory - get dirname and use basename as prefix
		searchDir = filepath.Dir(searchPath)
		prefix = filepath.Base(searchPath)

		// Verify the search directory exists
		if info, err := os.Stat(searchDir); err != nil || !info.IsDir() {
			return []Suggestion{}
		}
	}

	// Read directory entries
	entries, err := os.ReadDir(searchDir)
	if err != nil {
		return []Suggestion{}
	}

	var suggestions []Suggestion
	for _, entry := range entries {
		// Skip non-directories and hidden directories (except if user explicitly typed them)
		if !entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), ".") && !strings.HasPrefix(prefix, ".") {
			continue
		}

		// Check if name matches prefix
		if prefix != "" && !strings.HasPrefix(entry.Name(), prefix) {
			continue
		}

		fullPath := filepath.Join(searchDir, entry.Name())

		// Check if directory contains .git subdirectory
		gitPath := filepath.Join(fullPath, ".git")
		hasGit := false
		if gitInfo, err := os.Stat(gitPath); err == nil && gitInfo.IsDir() {
			hasGit = true
		}

		// Convert back to ~ format if it's under home directory
		homeDir, _ := os.UserHomeDir()
		displayPath := fullPath
		if homeDir != "" && strings.HasPrefix(fullPath, homeDir) {
			displayPath = "~" + strings.TrimPrefix(fullPath, homeDir)
		}

		suggestions = append(suggestions, Suggestion{
			Value: displayPath,
			Type:  "path",
			Valid: hasGit,
		})
	}

	// Limit to 10 suggestions
	if len(suggestions) > 10 {
		suggestions = suggestions[:10]
	}

	return suggestions
}

// ============================================================================
// Session File Endpoints
// ============================================================================

// ListSessionFiles lists directory contents for a session's workspace.
// GET /api/projects/{projectId}/sessions/{sessionId}/files?path=.&hidden=true
func (h *Handler) ListSessionFiles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)
	sessionID := chi.URLParam(r, "sessionId")

	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	// Path defaults to "." (root)
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "."
	}

	// Parse hidden flag
	includeHidden := r.URL.Query().Get("hidden") == "true"

	result, err := h.chatService.ListFiles(ctx, projectID, sessionID, path, includeHidden)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		h.Error(w, status, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, result)
}

// ReadSessionFile reads a file from a session's workspace.
// GET /api/projects/{projectId}/sessions/{sessionId}/files/read?path=...&fromBase=true
func (h *Handler) ReadSessionFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)
	sessionID := chi.URLParam(r, "sessionId")

	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	path := r.URL.Query().Get("path")
	if path == "" {
		h.Error(w, http.StatusBadRequest, "path query parameter required")
		return
	}

	fromBase := r.URL.Query().Get("fromBase") == "true"

	var result *sandboxapi.ReadFileResponse
	var err error

	if fromBase {
		result, err = h.chatService.ReadFileFromBase(ctx, projectID, sessionID, path)
	} else {
		result, err = h.chatService.ReadFile(ctx, projectID, sessionID, path)
	}

	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "Invalid path") {
			status = http.StatusBadRequest
		}
		h.Error(w, status, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, result)
}

// WriteSessionFile writes a file to a session's workspace.
// PUT /api/projects/{projectId}/sessions/{sessionId}/files/write
func (h *Handler) WriteSessionFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)
	sessionID := chi.URLParam(r, "sessionId")

	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	var req sandboxapi.WriteFileRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Path == "" {
		h.Error(w, http.StatusBadRequest, "path is required")
		return
	}

	result, err := h.chatService.WriteFile(ctx, projectID, sessionID, &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "Invalid path") {
			status = http.StatusBadRequest
		} else if strings.Contains(err.Error(), "Permission denied") {
			status = http.StatusForbidden
		}
		h.Error(w, status, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, result)
}

// GetSessionDiff returns diff information for a session's workspace.
// GET /api/projects/{projectId}/sessions/{sessionId}/diff?format=files&path=...
func (h *Handler) GetSessionDiff(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	projectID := middleware.GetProjectID(ctx)
	sessionID := chi.URLParam(r, "sessionId")

	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "sessionId is required")
		return
	}

	path := r.URL.Query().Get("path")
	format := r.URL.Query().Get("format")

	result, err := h.chatService.GetDiff(ctx, projectID, sessionID, path, format)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "Invalid path") {
			status = http.StatusBadRequest
		}
		h.Error(w, status, err.Error())
		return
	}

	h.JSON(w, http.StatusOK, result)
}
