package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/obot-platform/discobot/server/internal/middleware"
	"github.com/obot-platform/discobot/server/internal/providers"
	"github.com/obot-platform/discobot/server/internal/service"
)

// Icon is an alias for providers.Icon
type Icon = providers.Icon

// Badge represents a badge with label and styling
type Badge struct {
	Label     string `json:"label"`
	ClassName string `json:"className"`
}

// AgentType represents a supported agent type
type AgentType struct {
	ID                       string   `json:"id"`
	Name                     string   `json:"name"`
	Description              string   `json:"description"`
	Icons                    []Icon   `json:"icons,omitempty"`
	Badges                   []Badge  `json:"badges,omitempty"`
	Highlighted              bool     `json:"highlighted,omitempty"`
	SupportedAuthProviders   []string `json:"supportedAuthProviders,omitempty"`   // Use ["*"] for all providers
	HighlightedAuthProviders []string `json:"highlightedAuthProviders,omitempty"` // Featured auth providers for this agent
	AllowNoAuth              bool     `json:"allowNoAuth,omitempty"`
}

// Hardcoded agent types (matching TypeScript)
var agentTypes = []AgentType{
	{
		ID:          "claude-code",
		Name:        "Claude Code",
		Description: "Anthropic's Claude for coding",
		Icons: []Icon{
			{Src: "https://cdn.simpleicons.org/claude", MimeType: "image/svg+xml", Theme: "light"},
			{Src: "https://cdn.simpleicons.org/claude/white", MimeType: "image/svg+xml", Theme: "dark"},
		},
		Badges: []Badge{
			{Label: "Popular", ClassName: "bg-primary/10 text-primary"},
		},
		Highlighted:              true,
		SupportedAuthProviders:   []string{"anthropic"},
		HighlightedAuthProviders: []string{"anthropic"},
	},
	{
		ID:          "opencode",
		Name:        "OpenCode",
		Description: "Open source coding assistant",
		Icons: []Icon{
			{Src: "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/assets/logo-light.svg", MimeType: "image/svg+xml", Theme: "light"},
			{Src: "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/assets/logo-dark.svg", MimeType: "image/svg+xml", Theme: "dark"},
		},
		Badges: []Badge{
			{Label: "Popular", ClassName: "bg-primary/10 text-primary"},
			{Label: "Open Source", ClassName: "bg-green-500/10 text-green-600 dark:text-green-400"},
			{Label: "Free", ClassName: "bg-blue-500/10 text-blue-600 dark:text-blue-400"},
		},
		Highlighted:              true,
		SupportedAuthProviders:   []string{"*"},
		HighlightedAuthProviders: []string{"opencode", "anthropic", "codex"},
		AllowNoAuth:              true,
	},
	{
		ID:          "gemini-cli",
		Name:        "Gemini CLI",
		Description: "Google's Gemini CLI",
		Icons: []Icon{
			{Src: "https://cdn.simpleicons.org/googlegemini", MimeType: "image/svg+xml", Theme: "light"},
			{Src: "https://cdn.simpleicons.org/googlegemini/white", MimeType: "image/svg+xml", Theme: "dark"},
		},
		SupportedAuthProviders: []string{"google"},
	},
	{
		ID:          "aider",
		Name:        "Aider",
		Description: "AI pair programming",
		Icons: []Icon{
			{Src: "https://aider.chat/assets/logo.svg", MimeType: "image/svg+xml"},
		},
		SupportedAuthProviders: []string{"anthropic", "openai", "google", "deepseek"},
	},
	{
		ID:          "continue",
		Name:        "Continue",
		Description: "Open-source AI code assistant",
		Icons: []Icon{
			{Src: "https://raw.githubusercontent.com/continuedev/continue/main/extensions/vscode/media/icon.png", MimeType: "image/png"},
		},
		SupportedAuthProviders: []string{"anthropic", "openai"},
	},
	{
		ID:          "cursor-agent",
		Name:        "Cursor Agent",
		Description: "AI-first code editor agent",
		Icons: []Icon{
			{Src: "https://cdn.simpleicons.org/cursor", MimeType: "image/svg+xml", Theme: "light"},
			{Src: "https://cdn.simpleicons.org/cursor/white", MimeType: "image/svg+xml", Theme: "dark"},
		},
		SupportedAuthProviders: []string{"anthropic", "openai"},
	},
	{
		ID:          "codex",
		Name:        "Codex CLI",
		Description: "OpenAI Codex CLI",
		Icons: []Icon{
			{Src: "https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg", MimeType: "image/svg+xml"},
		},
		SupportedAuthProviders: []string{"openai", "codex"},
	},
	{
		ID:          "copilot-cli",
		Name:        "GitHub Copilot CLI",
		Description: "GitHub's AI pair programmer",
		Icons: []Icon{
			{Src: "https://cdn.simpleicons.org/githubcopilot", MimeType: "image/svg+xml", Theme: "light"},
			{Src: "https://cdn.simpleicons.org/githubcopilot/white", MimeType: "image/svg+xml", Theme: "dark"},
		},
		SupportedAuthProviders: []string{"github-copilot"},
	},
}

// ListAgents returns all agents for a project
func (h *Handler) ListAgents(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	agents, err := h.agentService.ListAgents(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list agents")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"agents": agents})
}

// CreateAgent creates a new agent
func (h *Handler) CreateAgent(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req struct {
		Name         string               `json:"name"`
		Description  string               `json:"description"`
		AgentType    string               `json:"agentType"`
		SystemPrompt string               `json:"systemPrompt"`
		MCPServers   []*service.MCPServer `json:"mcpServers"`
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

	agent, err := h.agentService.CreateAgent(r.Context(), projectID, req.Name, req.Description, req.AgentType, req.SystemPrompt, req.MCPServers)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create agent")
		return
	}

	h.JSON(w, http.StatusCreated, agent)
}

// GetAgentTypes returns supported agent types
func (h *Handler) GetAgentTypes(w http.ResponseWriter, _ *http.Request) {
	h.JSON(w, http.StatusOK, map[string]any{"agentTypes": agentTypes})
}

// GetAuthProviders returns available auth providers from models.dev data
func (h *Handler) GetAuthProviders(w http.ResponseWriter, _ *http.Request) {
	h.JSON(w, http.StatusOK, map[string]any{"authProviders": providers.GetAll()})
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

	if err := h.agentService.SetDefaultAgent(r.Context(), projectID, req.AgentID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to set default agent")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

// GetAgent returns a single agent
func (h *Handler) GetAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agentId")

	agent, err := h.agentService.GetAgent(r.Context(), agentID)
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
		Name         string               `json:"name"`
		Description  string               `json:"description"`
		SystemPrompt string               `json:"systemPrompt"`
		MCPServers   []*service.MCPServer `json:"mcpServers"`
	}
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	agent, err := h.agentService.UpdateAgent(r.Context(), agentID, req.Name, req.Description, req.SystemPrompt, req.MCPServers)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to update agent")
		return
	}

	h.JSON(w, http.StatusOK, agent)
}

// DeleteAgent deletes an agent
func (h *Handler) DeleteAgent(w http.ResponseWriter, r *http.Request) {
	agentID := chi.URLParam(r, "agentId")

	if err := h.agentService.DeleteAgent(r.Context(), agentID); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete agent")
		return
	}

	h.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
