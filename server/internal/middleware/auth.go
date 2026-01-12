package middleware

import (
	"context"
	"net/http"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/anthropics/octobot/server/internal/store"
)

type contextKey string

const (
	UserKey      contextKey = "user"
	UserIDKey    contextKey = "userID"
	UserEmailKey contextKey = "userEmail"
)

const sessionCookieName = "octobot_session"

// Auth middleware validates user authentication.
// If auth is disabled (cfg.AuthEnabled == false), it uses the anonymous user.
func Auth(s *store.Store, cfg *config.Config) func(http.Handler) http.Handler {
	authService := service.NewAuthService(s, cfg)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// If auth is disabled, use anonymous user
			if !cfg.AuthEnabled {
				anonUser := &service.User{
					ID:    model.AnonymousUserID,
					Email: model.AnonymousUserEmail,
					Name:  model.AnonymousUserName,
				}
				ctx := context.WithValue(r.Context(), UserKey, anonUser)
				ctx = context.WithValue(ctx, UserIDKey, anonUser.ID)
				ctx = context.WithValue(ctx, UserEmailKey, anonUser.Email)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}

			// Get session cookie
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil {
				http.Error(w, `{"error":"Authentication required"}`, http.StatusUnauthorized)
				return
			}

			// Validate session
			user, err := authService.ValidateSession(r.Context(), cookie.Value)
			if err != nil {
				// Clear invalid cookie
				http.SetCookie(w, &http.Cookie{
					Name:     sessionCookieName,
					Value:    "",
					Path:     "/",
					HttpOnly: true,
					MaxAge:   -1,
				})
				http.Error(w, `{"error":"Session expired"}`, http.StatusUnauthorized)
				return
			}

			// Add user info to context
			ctx := context.WithValue(r.Context(), UserKey, user)
			ctx = context.WithValue(ctx, UserIDKey, user.ID)
			ctx = context.WithValue(ctx, UserEmailKey, user.Email)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetUser extracts user from context
func GetUser(ctx context.Context) *service.User {
	if user, ok := ctx.Value(UserKey).(*service.User); ok {
		return user
	}
	return nil
}

// GetUserID extracts user ID from context
func GetUserID(ctx context.Context) string {
	if id, ok := ctx.Value(UserIDKey).(string); ok {
		return id
	}
	return ""
}

// GetUserEmail extracts user email from context
func GetUserEmail(ctx context.Context) string {
	if email, ok := ctx.Value(UserEmailKey).(string); ok {
		return email
	}
	return ""
}

// OptionalAuth middleware allows unauthenticated requests but adds user info if authenticated
func OptionalAuth(s *store.Store, cfg *config.Config) func(http.Handler) http.Handler {
	authService := service.NewAuthService(s, cfg)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Get session cookie
			cookie, err := r.Cookie(sessionCookieName)
			if err != nil {
				// No cookie, continue without auth
				next.ServeHTTP(w, r)
				return
			}

			// Validate session
			user, err := authService.ValidateSession(r.Context(), cookie.Value)
			if err != nil {
				// Invalid session, continue without auth
				next.ServeHTTP(w, r)
				return
			}

			// Add user info to context
			ctx := context.WithValue(r.Context(), UserKey, user)
			ctx = context.WithValue(ctx, UserIDKey, user.ID)
			ctx = context.WithValue(ctx, UserEmailKey, user.Email)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
