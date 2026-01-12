package handler

import (
	"net/http"
)

// Chat handles AI chat streaming
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement AI chat with SSE streaming
	h.Error(w, http.StatusNotImplemented, "AI chat not yet implemented")
}
