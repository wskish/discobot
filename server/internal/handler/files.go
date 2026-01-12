package handler

import (
	"net/http"
)

// GetFile returns a single file with diff content
func (h *Handler) GetFile(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement - this will use git service
	h.Error(w, http.StatusNotImplemented, "Not yet implemented")
}

// GetSuggestions returns autocomplete suggestions
func (h *Handler) GetSuggestions(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement path/repo suggestions
	h.JSON(w, http.StatusOK, map[string]any{"suggestions": []any{}})
}
