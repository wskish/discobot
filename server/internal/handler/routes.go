package handler

import (
	"net/http"

	"github.com/obot-platform/discobot/server/internal/routes"
)

// GetRoutes returns all registered API routes with their metadata.
// This endpoint powers the API UI's dynamic route listing.
func (h *Handler) GetRoutes(w http.ResponseWriter, _ *http.Request) {
	h.JSON(w, http.StatusOK, routes.All())
}
