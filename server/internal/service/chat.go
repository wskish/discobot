package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"

	"github.com/obot-platform/discobot/server/internal/events"
	"github.com/obot-platform/discobot/server/internal/jobs"
	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/sandbox/sandboxapi"
	"github.com/obot-platform/discobot/server/internal/store"
)

// JobEnqueuer is an interface for enqueuing background jobs.
// This breaks the import cycle between service and jobs packages.
type JobEnqueuer interface {
	Enqueue(ctx context.Context, payload jobs.JobPayload) error
}

// ChatService handles chat operations including session creation and message streaming.
type ChatService struct {
	store          *store.Store
	sessionService *SessionService
	jobEnqueuer    JobEnqueuer
	eventBroker    *events.Broker
	sandboxService *SandboxService
	gitService     *GitService

	// Git user config cache - populated once on first use
	gitConfigOnce sync.Once
	gitUserName   string
	gitUserEmail  string
}

// NewChatService creates a new chat service.
func NewChatService(s *store.Store, sessionService *SessionService, jobEnqueuer JobEnqueuer, eventBroker *events.Broker, sandboxService *SandboxService, gitService *GitService) *ChatService {
	return &ChatService{
		store:          s,
		sessionService: sessionService,
		jobEnqueuer:    jobEnqueuer,
		eventBroker:    eventBroker,
		sandboxService: sandboxService,
		gitService:     gitService,
	}
}

// NewSessionRequest contains the parameters for creating a new chat session.
type NewSessionRequest struct {
	// SessionID is the client-provided session ID (required)
	SessionID   string
	ProjectID   string
	WorkspaceID string
	AgentID     string
	Model       string
	Reasoning   string
	// Messages is the raw UIMessage array - passed through without parsing
	Messages json.RawMessage
}

// CancelCompletionResponse represents the response from cancelling a completion.
type CancelCompletionResponse struct {
	Success      bool   `json:"success"`
	CompletionID string `json:"completionId"`
	Status       string `json:"status"`
}

// ErrNoActiveCompletion is returned when attempting to cancel with no active completion.
var ErrNoActiveCompletion = errors.New("no active completion to cancel")

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
	sess, err := c.sessionService.CreateSessionWithID(ctx, req.SessionID, req.ProjectID, req.WorkspaceID, name, req.AgentID, req.Model, req.Reasoning)
	if err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}

	// Enqueue session initialization job (non-blocking)
	if err := c.jobEnqueuer.Enqueue(ctx, jobs.SessionInitPayload{
		ProjectID:   req.ProjectID,
		SessionID:   sess.ID,
		WorkspaceID: req.WorkspaceID,
		AgentID:     req.AgentID,
	}); err != nil {
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

// UpdateSessionModel updates the model for a session and broadcasts a session_updated event.
func (c *ChatService) UpdateSessionModel(ctx context.Context, sessionID, modelID string) error {
	session, err := c.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}
	session.Model = &modelID
	if err := c.store.UpdateSession(ctx, session); err != nil {
		return err
	}
	return c.eventBroker.PublishSessionUpdated(ctx, session.ProjectID, sessionID, string(session.Status), string(session.CommitStatus))
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

// getGitConfig returns the cached Git user configuration.
// On first call, fetches the config from GitService and caches it.
// Returns empty strings if Git config is not available or on error.
func (c *ChatService) getGitConfig(ctx context.Context) (name, email string) {
	c.gitConfigOnce.Do(func() {
		if c.gitService != nil {
			c.gitUserName, c.gitUserEmail = c.gitService.GetUserConfig(ctx)
			log.Printf("[ChatService] Cached Git user config: name=%q email=%q", c.gitUserName, c.gitUserEmail)
		} else {
			log.Printf("[ChatService] Git service not available, Git headers will not be sent")
		}
	})
	return c.gitUserName, c.gitUserEmail
}

// SendToSandbox sends messages to the sandbox and returns a channel of raw SSE lines.
// The sandbox handles message storage - we just proxy the stream without parsing.
// Both messages and responses are passed through as raw data.
// Credentials for the project are automatically included in the request header.
// Git user configuration is automatically included in request headers (cached on first use).
// If the sandbox is not running or doesn't exist, it will be reconciled on-demand.
// reasoning can be "enabled", "disabled", or "" for default behavior.
func (c *ChatService) SendToSandbox(ctx context.Context, projectID, sessionID string, messages json.RawMessage, requestModel string, reasoning string) (<-chan SSELine, error) {
	// Validate session belongs to project and get session for model
	session, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	// If a model is provided in the request, update the session's model
	if requestModel != "" {
		session.Model = &requestModel
		if err := c.store.UpdateSession(ctx, session); err != nil {
			log.Printf("Warning: failed to update session model for %s: %v", sessionID, err)
		}
	}

	// If reasoning is provided in the request, update the session's reasoning
	// Otherwise, use the session's saved reasoning (if any)
	effectiveReasoning := reasoning
	if reasoning != "" {
		session.Reasoning = &reasoning
		if err := c.store.UpdateSession(ctx, session); err != nil {
			log.Printf("Warning: failed to update session reasoning for %s: %v", sessionID, err)
		}
	} else if session.Reasoning != nil {
		// Use session's saved reasoning if no reasoning provided in request
		effectiveReasoning = *session.Reasoning
	}

	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Set session status to running before starting chat
	// UpdateStatus now automatically publishes SSE event
	if _, err := c.sessionService.UpdateStatus(ctx, projectID, sessionID, model.SessionStatusRunning, nil); err != nil {
		log.Printf("Warning: failed to update session status to running for %s: %v", sessionID, err)
	}
	// (in the handler) to ensure the agent API has received the request
	// before we start polling for status.

	// Get cached Git user config and pass it to the sandbox
	gitName, gitEmail := c.getGitConfig(ctx)
	opts := &RequestOptions{
		GitUserName:  gitName,
		GitUserEmail: gitEmail,
		Reasoning:    effectiveReasoning, // Pass effective reasoning flag to sandbox
	}

	// Use the model from the session (which may have just been updated)
	// Dereference model pointer; use empty string if nil (agent will use default)
	modelID := ""
	if session.Model != nil {
		modelID = *session.Model
	}

	return client.SendMessages(ctx, messages, modelID, opts)
}

// GetStream returns a channel of SSE events for an in-progress completion.
// If no completion is in progress, returns an empty closed channel.
// This is used by the resume endpoint to catch up on events.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) GetStream(ctx context.Context, projectID, sessionID string) (<-chan SSELine, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Get cached Git user config and pass it to the sandbox
	gitName, gitEmail := c.getGitConfig(ctx)
	opts := &RequestOptions{
		GitUserName:  gitName,
		GitUserEmail: gitEmail,
	}

	return client.GetStream(ctx, opts)
}

// GetMessages returns all messages for a session by querying the sandbox.
// The sandbox is automatically reconciled if not running.
// Returns an error if the sandbox cannot be reached after reconciliation.
func (c *ChatService) GetMessages(ctx context.Context, projectID, sessionID string) ([]sandboxapi.UIMessage, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Get cached Git user config and pass it to the sandbox
	gitName, gitEmail := c.getGitConfig(ctx)
	opts := &RequestOptions{
		GitUserName:  gitName,
		GitUserEmail: gitEmail,
	}

	return client.GetMessages(ctx, opts)
}

// CancelCompletion cancels an in-progress chat completion in the sandbox.
// Returns ErrNoActiveCompletion if no completion is active.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) CancelCompletion(ctx context.Context, projectID, sessionID string) (*CancelCompletionResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.CancelCompletion(ctx)
}

// ============================================================================
// File System Methods
// ============================================================================

// ListFiles lists directory contents in the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) ListFiles(ctx context.Context, projectID, sessionID, path string, includeHidden bool) (*sandboxapi.ListFilesResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.ListFiles(ctx, path, includeHidden)
}

// ReadFile reads file content from the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) ReadFile(ctx context.Context, projectID, sessionID, path string) (*sandboxapi.ReadFileResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.ReadFile(ctx, path)
}

// ReadFileFromBase reads a file from the base commit (for deleted files).
// This is useful for displaying diffs of deleted files.
func (c *ChatService) ReadFileFromBase(ctx context.Context, projectID, sessionID, path string) (*sandboxapi.ReadFileResponse, error) {
	// Validate session belongs to project
	session, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return nil, err
	}

	if c.gitService == nil {
		return nil, fmt.Errorf("git service not available")
	}

	// Get workspace to find base commit
	workspace, err := c.store.GetWorkspaceByID(ctx, session.WorkspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}

	// Use base commit from session if available, otherwise fetch current git HEAD
	var baseCommit string
	if session.BaseCommit != nil {
		baseCommit = *session.BaseCommit
	} else {
		// Fetch current git HEAD as the base commit
		gitStatus, err := c.gitService.Status(ctx, workspace.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to get workspace git status: %w", err)
		}
		if gitStatus.Commit == "" {
			return nil, fmt.Errorf("workspace has no commit")
		}
		baseCommit = gitStatus.Commit
	}

	// Read file from git at base commit
	content, err := c.gitService.ReadFile(ctx, workspace.ID, baseCommit, path)
	if err != nil {
		return nil, fmt.Errorf("failed to read file from base commit: %w", err)
	}

	return &sandboxapi.ReadFileResponse{
		Content:  string(content),
		Encoding: "utf-8",
		Size:     int64(len(content)),
	}, nil
}

// WriteFile writes file content to the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) WriteFile(ctx context.Context, projectID, sessionID string, req *sandboxapi.WriteFileRequest) (*sandboxapi.WriteFileResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.WriteFile(ctx, req)
}

// GetDiff retrieves diff information from the sandbox.
// If path is non-empty, returns a single file diff.
// If format is "files", returns just file paths.
// Otherwise returns full diff with patches.
// The agent-api calculates the merge-base automatically.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) GetDiff(ctx context.Context, projectID, sessionID, path, format string) (any, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.GetDiff(ctx, path, format)
}

// ============================================================================
// Service Methods
// ============================================================================

// ListServices retrieves all services from the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) ListServices(ctx context.Context, projectID, sessionID string) (*sandboxapi.ListServicesResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.ListServices(ctx)
}

// StartService starts a service in the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) StartService(ctx context.Context, projectID, sessionID, serviceID string) (*sandboxapi.StartServiceResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.StartService(ctx, serviceID)
}

// StopService stops a service in the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) StopService(ctx context.Context, projectID, sessionID, serviceID string) (*sandboxapi.StopServiceResponse, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.StopService(ctx, serviceID)
}

// GetServiceOutput returns a channel of SSE events for a service's output.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) GetServiceOutput(ctx context.Context, projectID, sessionID, serviceID string) (<-chan SSELine, error) {
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}
	if c.sandboxService == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}
	client, err := c.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	return client.GetServiceOutput(ctx, serviceID)
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
					// Trim leading/trailing whitespace
					trimmed := strings.TrimSpace(part.Text)
					// Only return if there's actual content after trimming
					if trimmed != "" {
						return trimmed
					}
				}
			}
		}
	}

	return "New Session"
}
