package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/obot-platform/octobot/server/internal/events"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/sandbox/sandboxapi"
	"github.com/obot-platform/octobot/server/internal/store"
)

// SessionInitEnqueuer is an interface for enqueuing session initialization jobs.
// This breaks the import cycle between service and jobs packages.
type SessionInitEnqueuer interface {
	EnqueueSessionInit(ctx context.Context, projectID, sessionID, workspaceID, agentID string) error
}

// ChatService handles chat operations including session creation and message streaming.
type ChatService struct {
	store             *store.Store
	sessionService    *SessionService
	credentialService *CredentialService
	jobEnqueuer       SessionInitEnqueuer
	eventBroker       *events.Broker
	sandboxClient     *SandboxChatClient
}

// NewChatService creates a new chat service.
func NewChatService(s *store.Store, sessionService *SessionService, credentialService *CredentialService, jobEnqueuer SessionInitEnqueuer, eventBroker *events.Broker, sandboxProvider sandbox.Provider) *ChatService {
	var client *SandboxChatClient
	if sandboxProvider != nil {
		client = NewSandboxChatClient(sandboxProvider)
	}
	return &ChatService{
		store:             s,
		sessionService:    sessionService,
		credentialService: credentialService,
		jobEnqueuer:       jobEnqueuer,
		eventBroker:       eventBroker,
		sandboxClient:     client,
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

// SendToSandbox sends messages to the sandbox and returns a channel of raw SSE lines.
// The sandbox handles message storage - we just proxy the stream without parsing.
// Both messages and responses are passed through as raw data.
// Credentials for the project are automatically included in the request header.
// If the sandbox doesn't exist (e.g., container was deleted), it will be recreated on-demand.
func (c *ChatService) SendToSandbox(ctx context.Context, projectID, sessionID string, messages json.RawMessage) (<-chan SSELine, error) {
	// Validate session belongs to project
	_, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Fetch credentials for the project
	opts := c.getCredentialOpts(ctx, projectID)

	// Try to send to sandbox
	ch, err := c.sandboxClient.SendMessages(ctx, sessionID, messages, opts)
	if err != nil {
		// Check if sandbox doesn't exist or isn't running - recreate it on-demand
		// Sandboxes are stateless and can be recreated from the session configuration
		if errors.Is(err, sandbox.ErrNotFound) || errors.Is(err, sandbox.ErrNotRunning) || isSandboxUnavailableError(err) {
			log.Printf("Sandbox unavailable for session %s, reinitializing on-demand: %v", sessionID, err)

			// Update session status to show reinitialization is happening
			if _, statusErr := c.sessionService.UpdateStatus(ctx, sessionID, model.SessionStatusReinitializing, nil); statusErr != nil {
				log.Printf("Warning: failed to update session status for %s: %v", sessionID, statusErr)
			}

			// Emit SSE event for status change
			if c.eventBroker != nil {
				if pubErr := c.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusReinitializing); pubErr != nil {
					log.Printf("Warning: failed to publish session update event: %v", pubErr)
				}
			}

			// Reinitialize the sandbox synchronously
			if initErr := c.sessionService.Initialize(ctx, sessionID); initErr != nil {
				return nil, fmt.Errorf("sandbox unavailable and failed to reinitialize: %w", initErr)
			}

			// Retry sending messages after successful reinitialization
			return c.sandboxClient.SendMessages(ctx, sessionID, messages, opts)
		}
		return nil, err
	}

	return ch, nil
}

// isSandboxUnavailableError checks if the error indicates the sandbox is unavailable
// and should be recreated. This handles cases where the error message indicates
// the sandbox doesn't exist or isn't running, but wasn't wrapped with sentinel errors.
func isSandboxUnavailableError(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	// Check for common sandbox unavailability messages
	return strings.Contains(errStr, "sandbox not found") ||
		strings.Contains(errStr, "sandbox is not running") ||
		strings.Contains(errStr, "container not found") ||
		strings.Contains(errStr, "No such container")
}

// getCredentialOpts fetches credentials for a project and returns RequestOptions.
// Returns nil if credentials are not available or an error occurs.
func (c *ChatService) getCredentialOpts(ctx context.Context, projectID string) *RequestOptions {
	if c.credentialService == nil {
		return nil
	}

	creds, err := c.credentialService.GetAllDecrypted(ctx, projectID)
	if err != nil {
		// Log but don't fail - credentials are optional
		fmt.Printf("Warning: failed to fetch credentials for project %s: %v\n", projectID, err)
		return nil
	}

	if len(creds) == 0 {
		return nil
	}

	return &RequestOptions{Credentials: creds}
}

// GetMessages returns all messages for a session by querying the sandbox.
// Returns empty slice if sandbox is not available or not running.
func (c *ChatService) GetMessages(ctx context.Context, projectID, sessionID string) ([]sandboxapi.UIMessage, error) {
	// Validate session belongs to project
	_, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		// Sandbox provider not available, return empty messages
		return []sandboxapi.UIMessage{}, nil
	}

	opts := c.getCredentialOpts(ctx, projectID)
	messages, err := c.sandboxClient.GetMessages(ctx, sessionID, opts)
	if err != nil {
		// Sandbox not running or not accessible, return empty messages
		return []sandboxapi.UIMessage{}, nil
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
