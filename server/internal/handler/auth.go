package handler

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/service"
)

// AuthLogin handles OAuth login redirect
func (h *Handler) AuthLogin(w http.ResponseWriter, r *http.Request) {
	// If auth is disabled, redirect to home
	if !h.cfg.AuthEnabled {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
		return
	}

	provider := chi.URLParam(r, "provider")

	// Generate state for CSRF protection
	state, err := service.GenerateState()
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to generate state")
		return
	}

	// Store state in cookie
	h.setStateCookie(w, state)

	// Build redirect URL
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	redirectURL := fmt.Sprintf("%s://%s/auth/callback/%s", scheme, r.Host, provider)

	// Get authorization URL
	authURL, err := h.authService.GetAuthURL(provider, redirectURL, state)
	if err != nil {
		h.Error(w, http.StatusBadRequest, err.Error())
		return
	}

	http.Redirect(w, r, authURL, http.StatusTemporaryRedirect)
}

// AuthCallback handles OAuth callback
func (h *Handler) AuthCallback(w http.ResponseWriter, r *http.Request) {
	// If auth is disabled, redirect to home
	if !h.cfg.AuthEnabled {
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
		return
	}

	provider := chi.URLParam(r, "provider")

	// Verify state
	state := r.URL.Query().Get("state")
	savedState := h.getStateCookie(w, r)
	if state == "" || state != savedState {
		h.Error(w, http.StatusBadRequest, "Invalid state parameter")
		return
	}

	// Check for error from provider
	if errMsg := r.URL.Query().Get("error"); errMsg != "" {
		errDesc := r.URL.Query().Get("error_description")
		h.Error(w, http.StatusBadRequest, fmt.Sprintf("OAuth error: %s - %s", errMsg, errDesc))
		return
	}

	// Get authorization code
	code := r.URL.Query().Get("code")
	if code == "" {
		h.Error(w, http.StatusBadRequest, "Missing authorization code")
		return
	}

	// Build redirect URL (must match the one used in login)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	redirectURL := fmt.Sprintf("%s://%s/auth/callback/%s", scheme, r.Host, provider)

	// Exchange code for user info
	providerUser, err := h.authService.ExchangeCode(r.Context(), provider, redirectURL, code)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, fmt.Sprintf("Failed to exchange code: %v", err))
		return
	}

	// Create or update user in database
	user, err := h.authService.CreateOrUpdateUser(r.Context(), providerUser)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, fmt.Sprintf("Failed to save user: %v", err))
		return
	}

	// Create session
	token, err := h.authService.CreateSession(r.Context(), user.ID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, fmt.Sprintf("Failed to create session: %v", err))
		return
	}

	// Set session cookie
	h.setSessionCookie(w, token)

	// Redirect to frontend
	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}

// AuthLogout handles user logout
func (h *Handler) AuthLogout(w http.ResponseWriter, r *http.Request) {
	// If auth is disabled, just return success (no sessions to clear)
	if !h.cfg.AuthEnabled {
		h.JSON(w, http.StatusOK, map[string]bool{"success": true})
		return
	}

	token := h.getSessionToken(r)
	if token != "" {
		// Delete session from database
		_ = h.authService.DeleteSession(r.Context(), token)
	}

	// Clear session cookie
	h.clearSessionCookie(w)

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// AuthMe returns current user info
func (h *Handler) AuthMe(w http.ResponseWriter, r *http.Request) {
	// If auth is disabled, return anonymous user
	if !h.cfg.AuthEnabled {
		h.JSON(w, http.StatusOK, &service.User{
			ID:    model.AnonymousUserID,
			Email: model.AnonymousUserEmail,
			Name:  model.AnonymousUserName,
		})
		return
	}

	token := h.getSessionToken(r)
	if token == "" {
		h.Error(w, http.StatusUnauthorized, "Not authenticated")
		return
	}

	user, err := h.authService.ValidateSession(r.Context(), token)
	if err != nil {
		h.clearSessionCookie(w)
		h.Error(w, http.StatusUnauthorized, "Session expired")
		return
	}

	h.JSON(w, http.StatusOK, user)
}
