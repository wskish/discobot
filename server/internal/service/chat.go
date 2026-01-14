package service

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/events"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// SessionInitEnqueuer is an interface for enqueuing session initialization jobs.
// This breaks the import cycle between service and jobs packages.
type SessionInitEnqueuer interface {
	EnqueueSessionInit(ctx context.Context, projectID, sessionID, workspaceID, agentID string) error
}

// ChatService handles chat operations including session creation and message streaming.
type ChatService struct {
	store           *store.Store
	sessionService  *SessionService
	jobEnqueuer     SessionInitEnqueuer
	eventBroker     *events.Broker
	containerClient *ContainerChatClient
}

// NewChatService creates a new chat service.
func NewChatService(s *store.Store, sessionService *SessionService, jobEnqueuer SessionInitEnqueuer, eventBroker *events.Broker, containerRuntime container.Runtime) *ChatService {
	var client *ContainerChatClient
	if containerRuntime != nil {
		client = NewContainerChatClient(containerRuntime)
	}
	return &ChatService{
		store:           s,
		sessionService:  sessionService,
		jobEnqueuer:     jobEnqueuer,
		eventBroker:     eventBroker,
		containerClient: client,
	}
}

// NewSessionRequest contains the parameters for creating a new chat session.
type NewSessionRequest struct {
	// SessionID is the client-provided session ID (required)
	SessionID   string
	ProjectID   string
	WorkspaceID string
	AgentID     string
	// Messages is the raw UIMessage array - passed through without parsing
	Messages json.RawMessage
}

// NewSession creates a new chat session and enqueues initialization.
// Uses the client-provided session ID.
func (c *ChatService) NewSession(ctx context.Context, req NewSessionRequest) (string, error) {
	if req.SessionID == "" {
		return "", fmt.Errorf("session ID is required")
	}

	// Validate workspace belongs to project
	workspace, err := c.store.GetWorkspaceByID(ctx, req.WorkspaceID)
	if err != nil {
		return "", fmt.Errorf("workspace not found: %w", err)
	}
	if workspace.ProjectID != req.ProjectID {
		return "", fmt.Errorf("workspace does not belong to this project")
	}

	// Validate agent belongs to project
	agent, err := c.store.GetAgentByID(ctx, req.AgentID)
	if err != nil {
		return "", fmt.Errorf("agent not found: %w", err)
	}
	if agent.ProjectID != req.ProjectID {
		return "", fmt.Errorf("agent does not belong to this project")
	}

	// Try to derive session name from first user message text
	name := deriveSessionName(req.Messages)

	// Use SessionService to create the session with client-provided ID
	sess, err := c.sessionService.CreateSessionWithID(ctx, req.SessionID, req.ProjectID, req.WorkspaceID, name, req.AgentID)
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}

	// Enqueue session initialization job (non-blocking)
	if err := c.jobEnqueuer.EnqueueSessionInit(ctx, req.ProjectID, sess.ID, req.WorkspaceID, req.AgentID); err != nil {
		// Log but don't fail - session was created, init can be retried
		fmt.Printf("Warning: failed to enqueue session init for %s: %v\n", sess.ID, err)
	}

	return sess.ID, nil
}

// GetSession retrieves a session and validates it belongs to the project.
func (c *ChatService) GetSession(ctx context.Context, projectID, sessionID string) (*model.Session, error) {
	sess, err := c.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("session not found: %w", err)
	}
	if sess.ProjectID != projectID {
		return nil, fmt.Errorf("session does not belong to this project")
	}
	return sess, nil
}

// GetSessionByID retrieves a session by ID without project validation.
// Use this when you need to check existence before validating project ownership.
func (c *ChatService) GetSessionByID(ctx context.Context, sessionID string) (*model.Session, error) {
	return c.store.GetSessionByID(ctx, sessionID)
}

// ValidateSessionResources validates that a session's workspace and agent belong to the project.
func (c *ChatService) ValidateSessionResources(ctx context.Context, projectID string, session *model.Session) error {
	// Validate workspace belongs to project
	workspace, err := c.store.GetWorkspaceByID(ctx, session.WorkspaceID)
	if err != nil {
		return fmt.Errorf("workspace not found: %w", err)
	}
	if workspace.ProjectID != projectID {
		return fmt.Errorf("session's workspace does not belong to this project")
	}

	// Validate agent belongs to project (if set)
	if session.AgentID != nil {
		agent, err := c.store.GetAgentByID(ctx, *session.AgentID)
		if err != nil {
			return fmt.Errorf("agent not found: %w", err)
		}
		if agent.ProjectID != projectID {
			return fmt.Errorf("session's agent does not belong to this project")
		}
	}

	return nil
}

// SendToContainer sends messages to the container and returns a channel of raw SSE lines.
// The container handles message storage - we just proxy the stream without parsing.
// Both messages and responses are passed through as raw data.
func (c *ChatService) SendToContainer(ctx context.Context, projectID, sessionID string, messages json.RawMessage) (<-chan SSELine, error) {
	// Validate session belongs to project
	_, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.containerClient == nil {
		return nil, fmt.Errorf("container runtime not available")
	}

	// Send to container and return raw SSE channel directly
	return c.containerClient.SendMessages(ctx, sessionID, messages)
}

// GetMessages returns all messages for a session by querying the container.
// Returns empty slice if container is not available or not running.
func (c *ChatService) GetMessages(ctx context.Context, projectID, sessionID string) ([]UIMessage, error) {
	// Validate session belongs to project
	_, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.containerClient == nil {
		// Container runtime not available, return empty messages
		return []UIMessage{}, nil
	}

	messages, err := c.containerClient.GetMessages(ctx, sessionID)
	if err != nil {
		// Container not running or not accessible, return empty messages
		return []UIMessage{}, nil
	}

	return messages, nil
}

// deriveSessionName attempts to extract a session name from the messages.
// It looks for the first user message with text content.
// Returns "New Session" if no suitable text is found.
func deriveSessionName(messages json.RawMessage) string {
	if len(messages) == 0 {
		return "New Session"
	}

	// Minimal struct to extract just what we need
	type minimalPart struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type minimalMessage struct {
		Role  string        `json:"role"`
		Parts []minimalPart `json:"parts"`
	}

	var msgs []minimalMessage
	if err := json.Unmarshal(messages, &msgs); err != nil {
		return "New Session"
	}

	// Find first user message with text
	for _, msg := range msgs {
		if msg.Role == "user" {
			for _, part := range msg.Parts {
				if part.Type == "text" && part.Text != "" {
					name := part.Text
					if len(name) > 50 {
						name = name[:50] + "..."
					}
					return name
				}
			}
		}
	}

	return "New Session"
}
