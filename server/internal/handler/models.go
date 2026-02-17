package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/discobot/server/internal/middleware"
)

// ModelsResponse contains the list of available models
type ModelsResponse struct {
	Models []ModelInfo `json:"models"`
}

// ModelInfo represents a model in the API response
type ModelInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	Description string `json:"description,omitempty"`
	Reasoning   bool   `json:"reasoning,omitempty"` // Whether model supports extended thinking
}

// GetAgentModels returns available models for an agent based on configured credentials
func (h *Handler) GetAgentModels(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())
	agentID := chi.URLParam(r, "agentId")

	if agentID == "" {
		h.Error(w, http.StatusBadRequest, "Agent ID is required")
		return
	}

	models, err := h.modelsService.GetModelsForAgent(r.Context(), agentID, projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get models for agent")
		return
	}

	// Convert service models to API response
	modelInfos := make([]ModelInfo, len(models))
	for i, m := range models {
		modelInfos[i] = ModelInfo{
			ID:          m.ID,
			Name:        m.Name,
			Provider:    m.Provider,
			Description: m.Description,
			Reasoning:   m.Reasoning,
		}
	}

	h.JSON(w, http.StatusOK, ModelsResponse{Models: modelInfos})
}

// GetSessionModels returns available models for a session based on its agent and credentials
func (h *Handler) GetSessionModels(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")

	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "Session ID is required")
		return
	}

	models, err := h.modelsService.GetModelsForSession(r.Context(), sessionID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to get models for session")
		return
	}

	// Convert service models to API response
	modelInfos := make([]ModelInfo, len(models))
	for i, m := range models {
		modelInfos[i] = ModelInfo{
			ID:          m.ID,
			Name:        m.Name,
			Provider:    m.Provider,
			Description: m.Description,
			Reasoning:   m.Reasoning,
		}
	}

	h.JSON(w, http.StatusOK, ModelsResponse{Models: modelInfos})
}
