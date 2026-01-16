package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/store"
)

// MCPServerConfig represents an MCP server configuration
type MCPServerConfig struct {
	Type    string            `json:"type"` // "stdio" or "http"
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// MCPServer represents an MCP server
type MCPServer struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	Config  MCPServerConfig `json:"config"`
	Enabled bool            `json:"enabled"`
}

// Agent represents an agent configuration (for API responses)
type Agent struct {
	ID           string       `json:"id"`
	Name         string       `json:"name"`
	Description  string       `json:"description"`
	AgentType    string       `json:"agentType"`
	SystemPrompt string       `json:"systemPrompt,omitempty"`
	MCPServers   []*MCPServer `json:"mcpServers,omitempty"`
	IsDefault    bool         `json:"isDefault,omitempty"`
}

// AgentService handles agent operations
type AgentService struct {
	store *store.Store
}

// NewAgentService creates a new agent service
func NewAgentService(s *store.Store) *AgentService {
	return &AgentService{store: s}
}

// ListAgents returns all agents for a project
func (s *AgentService) ListAgents(ctx context.Context, projectID string) ([]*Agent, error) {
	dbAgents, err := s.store.ListAgentsByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list agents: %w", err)
	}

	agents := make([]*Agent, len(dbAgents))
	for i, ag := range dbAgents {
		agent := s.mapAgent(ag)
		// Fetch MCP servers for each agent
		mcpServers, _ := s.store.ListAgentMCPServers(ctx, ag.ID)
		agent.MCPServers = s.mapMCPServers(mcpServers)
		agents[i] = agent
	}
	return agents, nil
}

// GetAgent returns an agent by ID
func (s *AgentService) GetAgent(ctx context.Context, agentID string) (*Agent, error) {
	ag, err := s.store.GetAgentByID(ctx, agentID)
	if err != nil {
		return nil, fmt.Errorf("failed to get agent: %w", err)
	}

	agent := s.mapAgent(ag)
	mcpServers, _ := s.store.ListAgentMCPServers(ctx, ag.ID)
	agent.MCPServers = s.mapMCPServers(mcpServers)
	return agent, nil
}

// CreateAgent creates a new agent
func (s *AgentService) CreateAgent(ctx context.Context, projectID string, name, description, agentType, systemPrompt string, mcpServers []*MCPServer) (*Agent, error) {
	var descPtr, promptPtr *string
	if description != "" {
		descPtr = &description
	}
	if systemPrompt != "" {
		promptPtr = &systemPrompt
	}

	ag := &model.Agent{
		ProjectID:    projectID,
		Name:         name,
		Description:  descPtr,
		AgentType:    agentType,
		SystemPrompt: promptPtr,
		IsDefault:    false,
	}
	if err := s.store.CreateAgent(ctx, ag); err != nil {
		return nil, fmt.Errorf("failed to create agent: %w", err)
	}

	// Create MCP servers
	for _, mcp := range mcpServers {
		configJSON, _ := json.Marshal(mcp.Config)
		server := &model.AgentMCPServer{
			AgentID: ag.ID,
			Name:    mcp.Name,
			Config:  configJSON,
			Enabled: mcp.Enabled,
		}
		_ = s.store.CreateAgentMCPServer(ctx, server)
	}

	agent := s.mapAgent(ag)
	agent.MCPServers = mcpServers
	return agent, nil
}

// UpdateAgent updates an agent
func (s *AgentService) UpdateAgent(ctx context.Context, agentID, name, description, systemPrompt string, mcpServers []*MCPServer) (*Agent, error) {
	ag, err := s.store.GetAgentByID(ctx, agentID)
	if err != nil {
		return nil, fmt.Errorf("failed to get agent: %w", err)
	}

	ag.Name = name
	if description != "" {
		ag.Description = &description
	}
	if systemPrompt != "" {
		ag.SystemPrompt = &systemPrompt
	}

	if err := s.store.UpdateAgent(ctx, ag); err != nil {
		return nil, fmt.Errorf("failed to update agent: %w", err)
	}

	// Update MCP servers - delete all and recreate
	if mcpServers != nil {
		_ = s.store.DeleteAgentMCPServersByAgent(ctx, agentID)
		for _, mcp := range mcpServers {
			configJSON, _ := json.Marshal(mcp.Config)
			server := &model.AgentMCPServer{
				AgentID: agentID,
				Name:    mcp.Name,
				Config:  configJSON,
				Enabled: mcp.Enabled,
			}
			_ = s.store.CreateAgentMCPServer(ctx, server)
		}
	}

	agent := s.mapAgent(ag)
	if mcpServers != nil {
		agent.MCPServers = mcpServers
	} else {
		servers, _ := s.store.ListAgentMCPServers(ctx, agentID)
		agent.MCPServers = s.mapMCPServers(servers)
	}
	return agent, nil
}

// DeleteAgent deletes an agent
func (s *AgentService) DeleteAgent(ctx context.Context, agentID string) error {
	// Delete MCP servers first
	_ = s.store.DeleteAgentMCPServersByAgent(ctx, agentID)
	return s.store.DeleteAgent(ctx, agentID)
}

// SetDefaultAgent sets the default agent for a project
func (s *AgentService) SetDefaultAgent(ctx context.Context, projectID, agentID string) error {
	return s.store.SetDefaultAgent(ctx, projectID, agentID)
}

// mapAgent maps a model Agent to a service Agent
func (s *AgentService) mapAgent(ag *model.Agent) *Agent {
	description := ""
	if ag.Description != nil {
		description = *ag.Description
	}
	systemPrompt := ""
	if ag.SystemPrompt != nil {
		systemPrompt = *ag.SystemPrompt
	}

	return &Agent{
		ID:           ag.ID,
		Name:         ag.Name,
		Description:  description,
		AgentType:    ag.AgentType,
		SystemPrompt: systemPrompt,
		IsDefault:    ag.IsDefault,
		MCPServers:   []*MCPServer{},
	}
}

// mapMCPServers maps model MCP servers to service MCPServers
func (s *AgentService) mapMCPServers(servers []*model.AgentMCPServer) []*MCPServer {
	result := make([]*MCPServer, len(servers))
	for i, srv := range servers {
		var cfg MCPServerConfig
		_ = json.Unmarshal(srv.Config, &cfg)
		result[i] = &MCPServer{
			ID:      srv.ID,
			Name:    srv.Name,
			Config:  cfg,
			Enabled: srv.Enabled,
		}
	}
	return result
}
