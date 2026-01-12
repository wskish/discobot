package handler

import (
	"net/http"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/go-chi/chi/v5"
)

// AgentType represents a supported agent type
type AgentType struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	Description            string   `json:"description"`
	SupportedAuthProviders []string `json:"supportedAuthProviders,omitempty"`
}

// Hardcoded agent types (matching TypeScript)
var agentTypes = []AgentType{
	{ID: "claude-code", Name: "Claude Code", Description: "Anthropic's Claude for coding", SupportedAuthProviders: []string{"anthropic"}},
	{ID: "opencode", Name: "OpenCode", Description: "Open source coding assistant", SupportedAuthProviders: []string{"*"}},
	{ID: "gemini-cli", Name: "Gemini CLI", Description: "Google's Gemini CLI", SupportedAuthProviders: []string{"google"}},
	{ID: "aider", Name: "Aider", Description: "AI pair programming", SupportedAuthProviders: []string{"anthropic", "openai", "google", "deepseek"}},
	{ID: "continue", Name: "Continue", Description: "Open-source AI code assistant", SupportedAuthProviders: []string{"anthropic", "openai"}},
	{ID: "cursor-agent", Name: "Cursor Agent", Description: "AI-first code editor agent", SupportedAuthProviders: []string{"anthropic", "openai"}},
	{ID: "codex", Name: "Codex CLI", Description: "OpenAI Codex CLI", SupportedAuthProviders: []string{"openai", "codex"}},
	{ID: "copilot-cli", Name: "GitHub Copilot CLI", Description: "GitHub's AI pair programmer", SupportedAuthProviders: []string{"github-copilot"}},
}

// agentService returns an agent service (created on demand)
func (h *Handler) agentService() *service.AgentService {
	return service.NewAgentService(h.store)
}

// ListAgents returns all agents for a project
func (h *Handler) ListAgents(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	agents, err := h.agentService().ListAgents(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list agents")
		return
	}

	h.JSON(w, http.StatusOK, agents)
}

// CreateAgent creates a new agent
func (h *Handler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req struct {
		Name         string                `json:"name"`
		Description  string                `json:"description"`
		AgentType    string                `json:"agentType"`
		SystemPrompt string                `json:"systemPrompt"`
		MCPServers   []*service.MCPServer  `json:"mcpServers"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" {
		h.Error(w, http.StatusBadRequest, "Name is required")
		return
	}
	if req.AgentType == "" {
		h.Error(w, http.StatusBadRequest, "Agent type is required")
		return
	}

	agent, err := h.agentService().CreateAgent(r.Context(), projectID, req.Name, req.Description, req.AgentType, req.SystemPrompt, req.MCPServers)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create agent")
		return
	}

	h.JSON(w, http.StatusCreated, agent)
}

// GetAgentTypes returns supported agent types
func (h *Handler) GetAgentTypes(w http.ResponseWriter, r *http.Request) {
	h.JSON(w, http.StatusOK, agentTypes)
}

// SetDefaultAgent sets the default agent for a project
func (h *Handler) SetDefaultAgent(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req struct {
		AgentID string `json:"agentId"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.AgentID == "" {
		h.Error(w, http.StatusBadRequest, "Agent ID is required")
		return
	}

	if err := h.agentService().SetDefaultAgent(r.Context(), projectID, req.AgentID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to set default agent")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// GetAgent returns a single agent
func (h *Handler) GetAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agentId")

	agent, err := h.agentService().GetAgent(r.Context(), agentID)
	if err != nil {
		h.Error(w, http.StatusNotFound, "Agent not found")
		return
	}

	h.JSON(w, http.StatusOK, agent)
}

// UpdateAgent updates an agent
func (h *Handler) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agentId")

	var req struct {
		Name         string                `json:"name"`
		Description  string                `json:"description"`
		SystemPrompt string                `json:"systemPrompt"`
		MCPServers   []*service.MCPServer  `json:"mcpServers"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	agent, err := h.agentService().UpdateAgent(r.Context(), agentID, req.Name, req.Description, req.SystemPrompt, req.MCPServers)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update agent")
		return
	}

	h.JSON(w, http.StatusOK, agent)
}

// DeleteAgent deletes an agent
func (h *Handler) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agentId")

	if err := h.agentService().DeleteAgent(r.Context(), agentID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete agent")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
