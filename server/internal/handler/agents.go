package handler

import (
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/anthropics/octobot/server/static"
)

// Icon represents an icon with theme support
type Icon struct {
	Src        string   `json:"src"`
	MimeType   string   `json:"mimeType,omitempty"`
	Sizes      []string `json:"sizes,omitempty"`
	Theme      string   `json:"theme,omitempty"`      // "light" or "dark"
	InvertDark bool     `json:"invertDark,omitempty"` // If true, invert colors for dark mode
}

// Badge represents a badge with label and styling
type Badge struct {
	Label     string `json:"label"`
	ClassName string `json:"className"`
}

// AuthProvider represents an auth provider option
type AuthProvider struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Icons       []Icon   `json:"icons,omitempty"`
	Env         []string `json:"env,omitempty"` // Environment variable names for API keys
}

// modelsDevProvider represents a provider from models.dev api.json
type modelsDevProvider struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	Doc  string   `json:"doc,omitempty"`
	Env  []string `json:"env,omitempty"`
}

// Cached auth providers loaded from models.dev data
var (
	authProvidersOnce   sync.Once
	cachedAuthProviders []AuthProvider
)

// Custom auth providers not available in models.dev
var customAuthProviders = []AuthProvider{
	{
		ID:          "codex",
		Name:        "Codex",
		Description: "OpenAI Codex CLI authentication",
		Icons: []Icon{
			{Src: "https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg", MimeType: "image/svg+xml", InvertDark: true},
		},
		Env: []string{"CODEX_API_KEY"},
	},
}

// loadAuthProviders loads auth providers from embedded models.dev data
func loadAuthProviders() []AuthProvider {
	authProvidersOnce.Do(func() {
		// Start with custom providers (not in models.dev)
		customIDs := make(map[string]bool)
		for _, p := range customAuthProviders {
			customIDs[p.ID] = true
		}
		cachedAuthProviders = append(cachedAuthProviders, customAuthProviders...)

		// Load models.dev data
		data, err := static.Files.ReadFile("models-dev-api.json")
		if err != nil {
			log.Printf("Warning: Failed to load models-dev-api.json: %v", err)
			return
		}

		var providers map[string]modelsDevProvider
		if err := json.Unmarshal(data, &providers); err != nil {
			log.Printf("Warning: Failed to parse models-dev-api.json: %v", err)
			return
		}

		// Add providers from models.dev (skip any that are in custom list)
		for id, p := range providers {
			if customIDs[id] {
				continue
			}
			description := p.Name + " API"
			if p.Doc != "" {
				description = p.Name + " API access"
			}
			cachedAuthProviders = append(cachedAuthProviders, AuthProvider{
				ID:          id,
				Name:        p.Name,
				Description: description,
				Icons: []Icon{
					{
						Src:        "https://models.dev/logos/" + id + ".svg",
						MimeType:   "image/svg+xml",
						InvertDark: true, // models.dev icons are black on white, need inversion for dark mode
					},
				},
				Env: p.Env,
			})
		}

		// Sort by name
		sort.Slice(cachedAuthProviders, func(i, j int) bool {
			return cachedAuthProviders[i].Name < cachedAuthProviders[j].Name
		})
	})
	return cachedAuthProviders
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

	agent, err := h.agentService().CreateAgent(r.Context(), projectID, req.Name, req.Description, req.AgentType, req.SystemPrompt, req.MCPServers)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to create agent")
		return
	}

	h.JSON(w, http.StatusCreated, agent)
}

// GetAgentTypes returns supported agent types
func (h *Handler) GetAgentTypes(w http.ResponseWriter, r *http.Request) {
	h.JSON(w, http.StatusOK, map[string]any{"agentTypes": agentTypes})
}

// GetAuthProviders returns available auth providers from models.dev data
func (h *Handler) GetAuthProviders(w http.ResponseWriter, r *http.Request) {
	h.JSON(w, http.StatusOK, map[string]any{"authProviders": loadAuthProviders()})
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
		Name         string               `json:"name"`
		Description  string               `json:"description"`
		SystemPrompt string               `json:"systemPrompt"`
		MCPServers   []*service.MCPServer `json:"mcpServers"`
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
