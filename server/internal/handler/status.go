package handler

import (
	"net/http"
	"os/exec"
)

// StatusMessageLevel represents the severity level of a status message
type StatusMessageLevel string

const (
	StatusLevelWarn  StatusMessageLevel = "warn"
	StatusLevelError StatusMessageLevel = "error"
)

// StatusMessage represents a status check message
type StatusMessage struct {
	ID      string             `json:"id"`
	Level   StatusMessageLevel `json:"level"`
	Title   string             `json:"title"`
	Message string             `json:"message"`
}

// SystemStatusResponse represents the system status check response
type SystemStatusResponse struct {
	OK       bool            `json:"ok"`
	Messages []StatusMessage `json:"messages"`
}

// GetSystemStatus checks system requirements and returns status
func (h *Handler) GetSystemStatus(w http.ResponseWriter, r *http.Request) {
	var messages []StatusMessage

	// Check for Git
	if _, err := exec.LookPath("git"); err != nil {
		messages = append(messages, StatusMessage{
			ID:      "git-not-found",
			Level:   StatusLevelWarn,
			Title:   "Git not found",
			Message: "Git is required for version control features. Please install Git to enable repository management.",
		})
	}

	// Check for Docker
	if _, err := exec.LookPath("docker"); err != nil {
		messages = append(messages, StatusMessage{
			ID:      "docker-not-found",
			Level:   StatusLevelWarn,
			Title:   "Docker not found",
			Message: "Docker is required for running coding agents in isolated containers. Please install Docker to enable agent execution.",
		})
	}

	// Determine if system is OK (no error-level messages)
	ok := true
	for _, msg := range messages {
		if msg.Level == StatusLevelError {
			ok = false
			break
		}
	}

	h.JSON(w, http.StatusOK, SystemStatusResponse{
		OK:       ok,
		Messages: messages,
	})
}
