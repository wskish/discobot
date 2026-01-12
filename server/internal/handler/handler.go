package handler

import (
	"encoding/json"
	"net/http"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/anthropics/octobot/server/internal/store"
)

const (
	sessionCookieName = "octobot_session"
	stateCookieName   = "octobot_oauth_state"
)

// Handler contains all HTTP handlers
type Handler struct {
	store             *store.Store
	cfg               *config.Config
	authService       *service.AuthService
	credentialService *service.CredentialService
}

// New creates a new Handler
func New(s *store.Store, cfg *config.Config) *Handler {
	credSvc, err := service.NewCredentialService(s, cfg)
	if err != nil {
		// This should only fail if the encryption key is invalid
		panic("failed to create credential service: " + err.Error())
	}

	return &Handler{
		store:             s,
		cfg:               cfg,
		authService:       service.NewAuthService(s, cfg),
		credentialService: credSvc,
	}
}

// JSON helper to write JSON responses
func (h *Handler) JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		json.NewEncoder(w).Encode(data)
	}
}

// Error helper to write error responses
func (h *Handler) Error(w http.ResponseWriter, status int, message string) {
	h.JSON(w, status, map[string]string{"error": message})
}

// DecodeJSON helper to decode request body
func (h *Handler) DecodeJSON(r *http.Request, v interface{}) error {
	return json.NewDecoder(r.Body).Decode(v)
}

// setSessionCookie sets the session cookie
func (h *Handler) setSessionCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   false, // Set to true in production with HTTPS
		SameSite: http.SameSiteLaxMode,
		MaxAge:   30 * 24 * 60 * 60, // 30 days
	})
}

// clearSessionCookie clears the session cookie
func (h *Handler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
}

// getSessionToken gets the session token from cookie
func (h *Handler) getSessionToken(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return cookie.Value
}

// setStateCookie sets the OAuth state cookie
func (h *Handler) setStateCookie(w http.ResponseWriter, state string) {
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    state,
		Path:     "/",
		HttpOnly: true,
		Secure:   false,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   10 * 60, // 10 minutes
	})
}

// getStateCookie gets and clears the OAuth state cookie
func (h *Handler) getStateCookie(w http.ResponseWriter, r *http.Request) string {
	cookie, err := r.Cookie(stateCookieName)
	if err != nil {
		return ""
	}
	// Clear the cookie
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	return cookie.Value
}
