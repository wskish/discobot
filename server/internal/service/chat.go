package service

import (
	"context"
	"fmt"

	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/events"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// ChatEvent represents an event in the chat stream.
// Follows the AI SDK UI Message Stream Protocol.
type ChatEvent struct {
	Type string // Event type (see constants below)

	// Common fields
	ID        string // Part ID for text/reasoning parts
	MessageID string // Message ID for start event
	Delta     string // Incremental content for delta events

	// Tool-related fields
	ToolCallID string // Tool call identifier
	ToolName   string // Name of the tool being called
	Input      any    // Tool input (for tool-input-available)
	Output     any    // Tool output (for tool-output-available)

	// Source/file fields
	SourceID  string // Source identifier
	URL       string // URL for source-url or file events
	MediaType string // MIME type for files/documents
	Title     string // Title for source-document
	Filename  string // Filename for file events

	// Error fields
	ErrorText string // Error message
	Reason    string // Abort reason

	// Custom data
	DataType string // For data-* events, the specific type
	Data     any    // Custom data payload
}

// ChatEvent type constants following AI SDK UI Message Stream Protocol
const (
	// Message flow events
	ChatEventStart  = "start"
	ChatEventFinish = "finish"
	ChatEventAbort  = "abort"

	// Text content events
	ChatEventTextStart = "text-start"
	ChatEventTextDelta = "text-delta"
	ChatEventTextEnd   = "text-end"

	// Reasoning events
	ChatEventReasoningStart = "reasoning-start"
	ChatEventReasoningDelta = "reasoning-delta"
	ChatEventReasoningEnd   = "reasoning-end"

	// Tool execution events
	ChatEventToolInputStart      = "tool-input-start"
	ChatEventToolInputDelta      = "tool-input-delta"
	ChatEventToolInputAvailable  = "tool-input-available"
	ChatEventToolOutputAvailable = "tool-output-available"

	// Reference events
	ChatEventSourceURL      = "source-url"
	ChatEventSourceDocument = "source-document"
	ChatEventFile           = "file"

	// Step events
	ChatEventStartStep  = "start-step"
	ChatEventFinishStep = "finish-step"

	// Error event
	ChatEventError = "error"
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
	ProjectID   string
	WorkspaceID string
	AgentID     string
	Prompt      string
}

// NewSession creates a new chat session and enqueues initialization.
// Returns the session ID immediately without waiting for initialization.
func (c *ChatService) NewSession(ctx context.Context, req NewSessionRequest) (string, error) {
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

	// Derive session name from prompt (first 50 chars)
	name := req.Prompt
	if len(name) > 50 {
		name = name[:50] + "..."
	}
	if name == "" {
		name = "New Session"
	}

	// Use SessionService to create the session and initial message
	sess, err := c.sessionService.CreateSession(ctx, req.ProjectID, req.WorkspaceID, name, req.AgentID, req.Prompt)
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

// GetSession retrieves an existing session and validates project ownership.
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

// SendToContainer sends a message to the container and returns a channel of events.
// The container handles message storage - we just proxy the stream.
func (c *ChatService) SendToContainer(ctx context.Context, projectID, sessionID, userMessage string) (<-chan ChatEvent, error) {
	// Validate session belongs to project
	_, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.containerClient == nil {
		return nil, fmt.Errorf("container runtime not available")
	}

	// Send to container
	containerEvents, err := c.containerClient.SendMessage(ctx, sessionID, userMessage)
	if err != nil {
		return nil, fmt.Errorf("failed to send to container: %w", err)
	}

	// Create output channel
	eventCh := make(chan ChatEvent, 100)

	// Forward container events to output
	go func() {
		defer close(eventCh)

		for containerEvent := range containerEvents {
			// Convert UIMessageEvent to ChatEvent
			chatEvent := ChatEvent{
				Type:       containerEvent.Type,
				ID:         containerEvent.ID,
				MessageID:  containerEvent.MessageID,
				Delta:      containerEvent.Delta,
				ToolCallID: containerEvent.ToolCallID,
				ToolName:   containerEvent.ToolName,
				Input:      containerEvent.Input,
				Output:     containerEvent.Output,
				ErrorText:  containerEvent.ErrorText,
				Reason:     containerEvent.Reason,
			}

			// Forward event to output
			select {
			case eventCh <- chatEvent:
			case <-ctx.Done():
				return
			}
		}
	}()

	return eventCh, nil
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
