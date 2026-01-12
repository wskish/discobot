package handler

import (
	"net/http"
)

// TerminalWebSocket handles WebSocket terminal connections
func (h *Handler) TerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement WebSocket upgrade and Docker PTY attach
	h.Error(w, http.StatusNotImplemented, "WebSocket terminal not yet implemented")
}

// GetTerminalHistory returns terminal history for a session
func (h *Handler) GetTerminalHistory(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	h.JSON(w, http.StatusOK, []interface{}{})
}

// GetTerminalStatus returns the container status
func (h *Handler) GetTerminalStatus(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement
	h.JSON(w, http.StatusOK, map[string]string{"status": "stopped"})
}
