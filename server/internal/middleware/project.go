package middleware

import (
	"context"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/octobot/server/internal/service"
	"github.com/obot-platform/octobot/server/internal/store"
)

const (
	ProjectIDKey   contextKey = "projectID"
	ProjectRoleKey contextKey = "projectRole"
)

// ProjectMember middleware validates project membership
func ProjectMember(s *store.Store) func(http.Handler) http.Handler {
	// Note: This middleware doesn't need sandbox provider since it only checks membership
	projectService := service.NewProjectService(s, nil)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			projectID := chi.URLParam(r, "projectId")
			if projectID == "" {
				http.Error(w, `{"error":"Project ID required"}`, http.StatusBadRequest)
				return
			}

			// Get user from context (set by Auth middleware)
			userID := GetUserID(r.Context())
			if userID == "" {
				http.Error(w, `{"error":"Authentication required"}`, http.StatusUnauthorized)
				return
			}

			// Check membership
			role, err := projectService.GetMemberRole(r.Context(), projectID, userID)
			if err != nil {
				http.Error(w, `{"error":"Access denied"}`, http.StatusForbidden)
				return
			}

			// Add project info to context
			ctx := context.WithValue(r.Context(), ProjectIDKey, projectID)
			ctx = context.WithValue(ctx, ProjectRoleKey, role)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// GetProjectID extracts project ID from context
func GetProjectID(ctx context.Context) string {
	if id, ok := ctx.Value(ProjectIDKey).(string); ok {
		return id
	}
	return ""
}

// GetProjectRole extracts project role from context
func GetProjectRole(ctx context.Context) string {
	if role, ok := ctx.Value(ProjectRoleKey).(string); ok {
		return role
	}
	return ""
}

// IsProjectOwner checks if user is project owner
func IsProjectOwner(ctx context.Context) bool {
	return GetProjectRole(ctx) == "owner"
}

// IsProjectAdmin checks if user is project admin or owner
func IsProjectAdmin(ctx context.Context) bool {
	role := GetProjectRole(ctx)
	return role == "owner" || role == "admin"
}
