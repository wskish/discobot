package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

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
		fetcher := makeCredentialFetcher(s, credentialService)
		client = NewSandboxChatClient(sandboxProvider, fetcher)
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

// ensureSandboxReady checks the session state from the database and ensures
// the sandbox is ready. This is a fast check (DB only) for known non-running states.
// For states like "stopped" or "error", it will trigger reconciliation.
// For "initializing" states, it will wait briefly then reconcile if still not ready.
func (c *ChatService) ensureSandboxReady(ctx context.Context, projectID, sessionID string) error {
	sess, err := c.GetSession(ctx, projectID, sessionID)
	if err != nil {
		return err
	}

	switch sess.Status {
	case model.SessionStatusReady:
		// Fast path: DB says running, assume good
		return nil
	case model.SessionStatusStopped, model.SessionStatusError:
		// Need to reconcile
		return c.reconcileSandbox(ctx, projectID, sessionID)
	case model.SessionStatusInitializing, model.SessionStatusReinitializing,
		model.SessionStatusCloning, model.SessionStatusPullingImage, model.SessionStatusCreatingSandbox:
		// Still initializing - wait briefly for it to complete
		if err := c.waitForSessionReady(ctx, sessionID); err != nil {
			// If wait failed/timed out, try to reconcile
			log.Printf("Session %s wait failed (%v), attempting reconciliation", sessionID, err)
			return c.reconcileSandbox(ctx, projectID, sessionID)
		}
		return nil
	default:
		// Unknown status - try to reconcile
		return c.reconcileSandbox(ctx, projectID, sessionID)
	}
}

// waitForSessionReady polls the session status until it reaches a terminal state.
// Terminal states are: running, error, or stopped.
// Returns an error if the session doesn't become ready within the timeout.
func (c *ChatService) waitForSessionReady(ctx context.Context, sessionID string) error {
	const (
		pollInterval = 500 * time.Millisecond
		maxWait      = 30 * time.Second
	)

	deadline := time.Now().Add(maxWait)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		sess, err := c.store.GetSessionByID(ctx, sessionID)
		if err != nil {
			return fmt.Errorf("session not found: %w", err)
		}

		switch sess.Status {
		case model.SessionStatusReady:
			return nil
		case model.SessionStatusError, model.SessionStatusStopped:
			// Terminal failure state - don't wait, let caller handle reconciliation
			return fmt.Errorf("session in %s state", sess.Status)
		}

		// Check timeout
		if time.Now().After(deadline) {
			return fmt.Errorf("timeout waiting for session to be ready (status: %s)", sess.Status)
		}

		// Wait for next poll or context cancellation
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			// Continue polling
		}
	}
}

// reconcileSandbox reinitializes the sandbox and updates status with SSE events.
func (c *ChatService) reconcileSandbox(ctx context.Context, projectID, sessionID string) error {
	log.Printf("Reconciling sandbox for session %s", sessionID)

	// Update status to reinitializing
	if _, err := c.sessionService.UpdateStatus(ctx, sessionID, model.SessionStatusReinitializing, nil); err != nil {
		log.Printf("Warning: failed to update session status for %s: %v", sessionID, err)
	}

	// Emit SSE event for status change
	if c.eventBroker != nil {
		if err := c.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusReinitializing, ""); err != nil {
			log.Printf("Warning: failed to publish session update event: %v", err)
		}
	}

	// Reinitialize the sandbox
	if err := c.sessionService.Initialize(ctx, sessionID); err != nil {
		return fmt.Errorf("failed to reinitialize sandbox: %w", err)
	}

	return nil
}

// withSandboxReconciliation wraps a sandbox operation with error handling
// that triggers reconciliation on sandbox unavailable errors, then retries.
func withSandboxReconciliation[T any](
	ctx context.Context,
	c *ChatService,
	projectID, sessionID string,
	operation func() (T, error),
) (T, error) {
	result, err := operation()
	if err == nil {
		return result, nil
	}

	// Check if sandbox is unavailable - reconcile and retry
	if errors.Is(err, sandbox.ErrNotFound) || errors.Is(err, sandbox.ErrNotRunning) || isSandboxUnavailableError(err) {
		log.Printf("Sandbox unavailable for session %s, reconciling: %v", sessionID, err)

		if reconcileErr := c.reconcileSandbox(ctx, projectID, sessionID); reconcileErr != nil {
			var zero T
			return zero, fmt.Errorf("sandbox unavailable and failed to reconcile: %w", reconcileErr)
		}

		// Retry operation after successful reconciliation
		return operation()
	}

	var zero T
	return zero, err
}

// SendToSandbox sends messages to the sandbox and returns a channel of raw SSE lines.
// The sandbox handles message storage - we just proxy the stream without parsing.
// Both messages and responses are passed through as raw data.
// Credentials for the project are automatically included in the request header.
// If the sandbox is not running or doesn't exist, it will be reconciled on-demand.
func (c *ChatService) SendToSandbox(ctx context.Context, projectID, sessionID string, messages json.RawMessage) (<-chan SSELine, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors (e.g., container deleted but DB says running)
	// Credentials are automatically fetched by sandboxClient
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (<-chan SSELine, error) {
		return c.sandboxClient.SendMessages(ctx, sessionID, messages, nil)
	})
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

// GetStream returns a channel of SSE events for an in-progress completion.
// If no completion is in progress, returns an empty closed channel.
// This is used by the resume endpoint to catch up on events.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) GetStream(ctx context.Context, projectID, sessionID string) (<-chan SSELine, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	// Credentials are automatically fetched by sandboxClient
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (<-chan SSELine, error) {
		return c.sandboxClient.GetStream(ctx, sessionID, nil)
	})
}

// GetMessages returns all messages for a session by querying the sandbox.
// The sandbox is automatically reconciled if not running.
// Returns an error if the sandbox cannot be reached after reconciliation.
func (c *ChatService) GetMessages(ctx context.Context, projectID, sessionID string) ([]sandboxapi.UIMessage, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	// Credentials are automatically fetched by sandboxClient
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() ([]sandboxapi.UIMessage, error) {
		return c.sandboxClient.GetMessages(ctx, sessionID, nil)
	})
}

// ============================================================================
// File System Methods
// ============================================================================

// ListFiles lists directory contents in the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) ListFiles(ctx context.Context, projectID, sessionID, path string, includeHidden bool) (*sandboxapi.ListFilesResponse, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (*sandboxapi.ListFilesResponse, error) {
		return c.sandboxClient.ListFiles(ctx, sessionID, path, includeHidden)
	})
}

// ReadFile reads file content from the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) ReadFile(ctx context.Context, projectID, sessionID, path string) (*sandboxapi.ReadFileResponse, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (*sandboxapi.ReadFileResponse, error) {
		return c.sandboxClient.ReadFile(ctx, sessionID, path)
	})
}

// WriteFile writes file content to the sandbox.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) WriteFile(ctx context.Context, projectID, sessionID string, req *sandboxapi.WriteFileRequest) (*sandboxapi.WriteFileResponse, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (*sandboxapi.WriteFileResponse, error) {
		return c.sandboxClient.WriteFile(ctx, sessionID, req)
	})
}

// GetDiff retrieves diff information from the sandbox.
// If path is non-empty, returns a single file diff.
// If format is "files", returns just file paths.
// Otherwise returns full diff with patches.
// The agent-api calculates the merge-base automatically.
// The sandbox is automatically reconciled if not running.
func (c *ChatService) GetDiff(ctx context.Context, projectID, sessionID, path, format string) (any, error) {
	// Validate session belongs to project
	if _, err := c.GetSession(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	if c.sandboxClient == nil {
		return nil, fmt.Errorf("sandbox provider not available")
	}

	// Check DB state first - fast reconciliation for known non-running states
	if err := c.ensureSandboxReady(ctx, projectID, sessionID); err != nil {
		return nil, err
	}

	// Use reconciliation wrapper for runtime errors
	return withSandboxReconciliation(ctx, c, projectID, sessionID, func() (any, error) {
		return c.sandboxClient.GetDiff(ctx, sessionID, path, format)
	})
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
