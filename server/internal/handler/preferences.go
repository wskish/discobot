package handler

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/discobot/server/internal/middleware"
	"github.com/obot-platform/discobot/server/internal/service"
	"github.com/obot-platform/discobot/server/internal/store"
)

// ListPreferences returns all preferences for the authenticated user
func (h *Handler) ListPreferences(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	prefs, err := h.preferenceService.ListPreferences(r.Context(), userID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list preferences")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"preferences": prefs})
}

// GetPreference returns a single preference by key
func (h *Handler) GetPreference(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	key := chi.URLParam(r, "key")
	if key == "" {
		h.Error(w, http.StatusBadRequest, "Key is required")
		return
	}

	pref, err := h.preferenceService.GetPreference(r.Context(), userID, key)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			h.Error(w, http.StatusNotFound, "Preference not found")
			return
		}
		h.Error(w, http.StatusInternalServerError, "Failed to get preference")
		return
	}

	h.JSON(w, http.StatusOK, pref)
}

// SetPreference creates or updates a preference
func (h *Handler) SetPreference(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	key := chi.URLParam(r, "key")
	if key == "" {
		h.Error(w, http.StatusBadRequest, "Key is required")
		return
	}

	var req struct {
		Value string `json:"value"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	pref, err := h.preferenceService.SetPreference(r.Context(), userID, key, req.Value)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to set preference")
		return
	}

	h.JSON(w, http.StatusOK, pref)
}

// SetPreferences sets multiple preferences at once
func (h *Handler) SetPreferences(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	var req struct {
		Preferences map[string]string `json:"preferences"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	var prefs []*service.UserPreference
	for key, value := range req.Preferences {
		pref, err := h.preferenceService.SetPreference(r.Context(), userID, key, value)
		if err != nil {
			h.Error(w, http.StatusInternalServerError, "Failed to set preferences")
			return
		}
		prefs = append(prefs, pref)
	}

	h.JSON(w, http.StatusOK, map[string]any{"preferences": prefs})
}

// DeletePreference deletes a preference by key
func (h *Handler) DeletePreference(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		h.Error(w, http.StatusUnauthorized, "Authentication required")
		return
	}

	key := chi.URLParam(r, "key")
	if key == "" {
		h.Error(w, http.StatusBadRequest, "Key is required")
		return
	}

	if err := h.preferenceService.DeletePreference(r.Context(), userID, key); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			h.Error(w, http.StatusNotFound, "Preference not found")
			return
		}
		h.Error(w, http.StatusInternalServerError, "Failed to delete preference")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
