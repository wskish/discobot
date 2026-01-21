package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"regexp"
	"time"

	"github.com/obot-platform/octobot/server/internal/events"
	"github.com/obot-platform/octobot/server/internal/git"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/store"
)

// SessionIDMaxLength is the maximum allowed length for a session ID.
const SessionIDMaxLength = 65

// sessionIDRegex matches valid session IDs (alphanumeric and hyphens only).
var sessionIDRegex = regexp.MustCompile(`^[a-zA-Z0-9-]+$`)

// ValidateSessionID validates that a session ID meets format requirements:
// - Only alphanumeric characters (a-z, A-Z, 0-9) and hyphens (-) are allowed
// - Maximum length is 65 characters
func ValidateSessionID(sessionID string) error {
	if sessionID == "" {
		return errors.New("session ID is required")
	}
	if len(sessionID) > SessionIDMaxLength {
		return fmt.Errorf("session ID exceeds maximum length of %d characters", SessionIDMaxLength)
	}
	if !sessionIDRegex.MatchString(sessionID) {
		return errors.New("session ID must contain only alphanumeric characters and hyphens")
	}
	return nil
}

// Session represents a chat session (for API responses)
type Session struct {
	ID            string     `json:"id"`
	ProjectID     string     `json:"projectId"`
	Name          string     `json:"name"`
	Description   string     `json:"description"`
	Timestamp     string     `json:"timestamp"`
	Status        string     `json:"status"`
	CommitStatus  string     `json:"commitStatus,omitempty"`
	CommitError   string     `json:"commitError,omitempty"`
	BaseCommit    string     `json:"baseCommit,omitempty"`
	AppliedCommit string     `json:"appliedCommit,omitempty"`
	ErrorMessage  string     `json:"errorMessage,omitempty"`
	Files         []FileNode `json:"files"`
	WorkspaceID   string     `json:"workspaceId,omitempty"`
	AgentID       string     `json:"agentId,omitempty"`
}

// FileNode represents a file in a session
type FileNode struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Type            string     `json:"type"`
	Children        []FileNode `json:"children,omitempty"`
	Content         string     `json:"content,omitempty"`
	OriginalContent string     `json:"originalContent,omitempty"`
	Changed         bool       `json:"changed,omitempty"`
}

// SessionService handles session operations
type SessionService struct {
	store           *store.Store
	gitProvider     git.Provider
	sandboxProvider sandbox.Provider
	sandboxClient   *SandboxChatClient
	eventBroker     *events.Broker
}

// NewSessionService creates a new session service
func NewSessionService(s *store.Store, gitProv git.Provider, sandboxProv sandbox.Provider, eventBroker *events.Broker) *SessionService {
	var client *SandboxChatClient
	if sandboxProv != nil {
		client = NewSandboxChatClient(sandboxProv)
	}
	return &SessionService{
		store:           s,
		gitProvider:     gitProv,
		sandboxProvider: sandboxProv,
		sandboxClient:   client,
		eventBroker:     eventBroker,
	}
}

// ListSessionsByWorkspace returns all sessions for a workspace
func (s *SessionService) ListSessionsByWorkspace(ctx context.Context, workspaceID string) ([]*Session, error) {
	dbSessions, err := s.store.ListSessionsByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to list sessions: %w", err)
	}

	sessions := make([]*Session, len(dbSessions))
	for i, sess := range dbSessions {
		sessions[i] = s.mapSession(sess)
	}
	return sessions, nil
}

// GetSession returns a session by ID
func (s *SessionService) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	return s.mapSession(sess), nil
}

// CreateSession creates a new session with initializing status and auto-generated ID.
// If initialMessage is provided, it creates the first user message in the session.
func (s *SessionService) CreateSession(ctx context.Context, projectID, workspaceID, name, agentID, initialMessage string) (*Session, error) {
	var aidPtr *string
	if agentID != "" {
		aidPtr = &agentID
	}

	sess := &model.Session{
		ProjectID:   projectID,
		WorkspaceID: workspaceID,
		AgentID:     aidPtr,
		Name:        name,
		Description: nil,
		Status:      model.SessionStatusInitializing,
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	// Create the initial user message if provided
	if initialMessage != "" {
		msg := &model.Message{
			SessionID: sess.ID,
			Role:      "user",
			Parts:     model.NewTextParts(initialMessage),
		}
		if err := s.store.CreateMessage(ctx, msg); err != nil {
			// Log the error but don't fail session creation
			log.Printf("Warning: failed to create initial message for session %s: %v", sess.ID, err)
		}
	}

	return s.mapSession(sess), nil
}

// CreateSessionWithID creates a new session with the provided client ID.
func (s *SessionService) CreateSessionWithID(ctx context.Context, sessionID, projectID, workspaceID, name, agentID string) (*Session, error) {
	var aidPtr *string
	if agentID != "" {
		aidPtr = &agentID
	}

	sess := &model.Session{
		ID:          sessionID, // Use client-provided ID
		ProjectID:   projectID,
		WorkspaceID: workspaceID,
		AgentID:     aidPtr,
		Name:        name,
		Description: nil,
		Status:      model.SessionStatusInitializing,
	}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to create session: %w", err)
	}

	return s.mapSession(sess), nil
}

// UpdateStatus updates only the session status and optional error message
func (s *SessionService) UpdateStatus(ctx context.Context, sessionID, status string, errorMsg *string) (*Session, error) {
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	sess.Status = status
	sess.ErrorMessage = errorMsg
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to update session status: %w", err)
	}

	return s.mapSession(sess), nil
}

// UpdateSession updates a session
func (s *SessionService) UpdateSession(ctx context.Context, sessionID, name, status string) (*Session, error) {
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}

	sess.Name = name
	sess.Status = status
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return nil, fmt.Errorf("failed to update session: %w", err)
	}

	return s.mapSession(sess), nil
}

// JobEnqueuer is an interface for enqueueing session jobs.
type JobEnqueuer interface {
	EnqueueSessionDelete(ctx context.Context, projectID, sessionID string) error
	EnqueueSessionCommit(ctx context.Context, projectID, sessionID string) error
}

// DeleteSession initiates async deletion of a session.
// It sets the session status to "removing", emits an SSE event, and enqueues a deletion job.
func (s *SessionService) DeleteSession(ctx context.Context, projectID, sessionID string, jobQueue JobEnqueuer) error {
	// Get session to verify it exists
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}

	// Don't allow deletion of sessions already being removed
	if sess.Status == model.SessionStatusRemoving {
		return nil // Already being deleted
	}

	// Update status to "removing"
	sess.Status = model.SessionStatusRemoving
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return fmt.Errorf("failed to update session status: %w", err)
	}

	// Emit SSE event
	if s.eventBroker != nil {
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusRemoving, sess.CommitStatus); err != nil {
			log.Printf("Failed to publish session removing event: %v", err)
		}
	}

	// Enqueue deletion job
	if err := jobQueue.EnqueueSessionDelete(ctx, projectID, sessionID); err != nil {
		// If job enqueueing fails, log but don't fail - the session is marked as removing
		// and can be cleaned up later by reconciliation
		log.Printf("Failed to enqueue session delete job for %s: %v", sessionID, err)
	}

	return nil
}

// CommitSession initiates async commit of a session.
// It captures the current workspace commit as baseCommit, sets commitStatus to "pending",
// emits an SSE event, and enqueues a commit job.
func (s *SessionService) CommitSession(ctx context.Context, projectID, sessionID string, jobQueue JobEnqueuer) error {
	// Get session to verify it exists and check status
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}

	// Don't allow commit if already committing
	if sess.CommitStatus == model.CommitStatusPending || sess.CommitStatus == model.CommitStatusCommitting {
		return fmt.Errorf("commit already in progress (status: %s)", sess.CommitStatus)
	}

	// Get current workspace commit to use as baseCommit
	gitStatus, err := s.gitProvider.Status(ctx, sess.WorkspaceID)
	if err != nil {
		return fmt.Errorf("failed to get workspace status: %w", err)
	}
	if gitStatus.Commit == "" {
		return fmt.Errorf("workspace has no commit")
	}

	// Update session with commit info
	sess.CommitStatus = model.CommitStatusPending
	sess.BaseCommit = ptrString(gitStatus.Commit)
	sess.AppliedCommit = nil // Clear any previous applied commit
	sess.CommitError = nil   // Clear any previous error
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return fmt.Errorf("failed to update session commit status: %w", err)
	}

	// Emit SSE event for commit status change
	s.publishCommitStatusChanged(ctx, projectID, sessionID, model.CommitStatusPending)

	// Enqueue commit job
	if err := jobQueue.EnqueueSessionCommit(ctx, projectID, sessionID); err != nil {
		// If job enqueueing fails, revert commit status
		log.Printf("Failed to enqueue session commit job for %s: %v", sessionID, err)
		sess.CommitStatus = model.CommitStatusNone
		sess.BaseCommit = nil
		if updateErr := s.store.UpdateSession(ctx, sess); updateErr != nil {
			log.Printf("Failed to revert session commit status: %v", updateErr)
		}
		s.publishCommitStatusChanged(ctx, projectID, sessionID, model.CommitStatusNone)
		return fmt.Errorf("failed to enqueue commit job: %w", err)
	}

	return nil
}

// publishCommitStatusChanged publishes an SSE event for commit status changes.
func (s *SessionService) publishCommitStatusChanged(ctx context.Context, projectID, sessionID, commitStatus string) {
	if s.eventBroker != nil {
		// Send empty string for session status since only commit status changed
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, "", commitStatus); err != nil {
			log.Printf("Failed to publish session commit status event: %v", err)
		}
	}
}

// PerformDeletion performs the actual session deletion work.
// This is called by the SessionDeleteExecutor job handler.
func (s *SessionService) PerformDeletion(ctx context.Context, projectID, sessionID string) error {
	// Step 1: Destroy sandbox (idempotent - handles not found)
	if s.sandboxProvider != nil {
		if err := s.sandboxProvider.Remove(ctx, sessionID); err != nil {
			if !errors.Is(err, sandbox.ErrNotFound) {
				return fmt.Errorf("failed to remove sandbox: %w", err)
			}
			// Sandbox not found is fine - continue with deletion
		}
	}

	// Step 2: Delete from database (messages, terminal history, session)
	if err := s.store.DeleteSession(ctx, sessionID); err != nil {
		return fmt.Errorf("failed to delete session from database: %w", err)
	}

	// Step 3: Emit "removed" event to notify clients
	if s.eventBroker != nil {
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusRemoved, ""); err != nil {
			log.Printf("Failed to publish session removed event: %v", err)
		}
	}

	log.Printf("Session %s deleted successfully", sessionID)
	return nil
}

// mapSession maps a model Session to a service Session
func (s *SessionService) mapSession(sess *model.Session) *Session {
	agentID := ""
	if sess.AgentID != nil {
		agentID = *sess.AgentID
	}

	description := ""
	if sess.Description != nil {
		description = *sess.Description
	}

	errorMessage := ""
	if sess.ErrorMessage != nil {
		errorMessage = *sess.ErrorMessage
	}

	commitError := ""
	if sess.CommitError != nil {
		commitError = *sess.CommitError
	}

	baseCommit := ""
	if sess.BaseCommit != nil {
		baseCommit = *sess.BaseCommit
	}

	appliedCommit := ""
	if sess.AppliedCommit != nil {
		appliedCommit = *sess.AppliedCommit
	}

	timestamp := sess.UpdatedAt.Format(time.RFC3339)
	if sess.UpdatedAt.IsZero() {
		timestamp = time.Now().Format(time.RFC3339)
	}

	return &Session{
		ID:            sess.ID,
		ProjectID:     sess.ProjectID,
		Name:          sess.Name,
		Description:   description,
		Timestamp:     timestamp,
		Status:        sess.Status,
		CommitStatus:  sess.CommitStatus,
		CommitError:   commitError,
		BaseCommit:    baseCommit,
		AppliedCommit: appliedCommit,
		ErrorMessage:  errorMessage,
		Files:         []FileNode{},
		WorkspaceID:   sess.WorkspaceID,
		AgentID:       agentID,
	}
}

// SessionConfig contains all the configuration needed for agent startup.
type SessionConfig struct {
	Session   *Session   `json:"session"`
	Workspace *Workspace `json:"workspace"`
	Agent     *Agent     `json:"agent"`
}

// Initialize performs the session initialization work synchronously.
// This is called by the dispatcher when processing a session_init job.
// The session must already exist in the database.
func (s *SessionService) Initialize(
	ctx context.Context,
	sessionID string,
) error {
	// Get session
	session, err := s.GetSession(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}

	// Get workspace info
	workspace, err := s.store.GetWorkspaceByID(ctx, session.WorkspaceID)
	if err != nil {
		s.updateStatusWithEvent(ctx, session.ProjectID, sessionID, model.SessionStatusError, ptrString("workspace not found: "+err.Error()))
		return fmt.Errorf("workspace not found: %w", err)
	}

	// Get agent info (optional)
	var agent *model.Agent
	agent, err = s.store.GetAgentByID(ctx, session.AgentID)
	if err != nil {
		s.updateStatusWithEvent(ctx, session.ProjectID, sessionID, model.SessionStatusError, ptrString("The agent used by this session has been deleted. Please create a new session with an available agent."))
		return fmt.Errorf("session's agent has been deleted")
	}

	// Run initialization synchronously
	return s.initializeSync(ctx, session.ProjectID, session, workspace, agent)
}

// initializeSync runs the initialization flow synchronously.
// The flow is: ensure workspace -> save workspace info on session -> create sandbox.
func (s *SessionService) initializeSync(
	ctx context.Context,
	projectID string,
	session *Session,
	workspace *model.Workspace,
	_ *model.Agent,
) error {
	sessionID := session.ID

	// Step 1: Ensure workspace (may involve git cloning)
	var workspacePath string
	var workspaceCommit string

	isGit := workspace.SourceType == "git" || git.IsGitURL(workspace.Path)

	if !isGit {
		// Local workspace - use path directly
		workspacePath = workspace.Path
	} else {
		// Git workspace - clone/update repository
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusCloning, nil)

		var err error
		workspacePath, workspaceCommit, err = s.gitProvider.EnsureWorkspace(ctx, projectID, workspace.ID, workspace.Path, "")
		if err != nil {
			log.Printf("Git clone failed for session %s: %v", sessionID, err)
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("git clone failed: "+err.Error()))
			return fmt.Errorf("git clone failed: %w", err)
		}
	}

	// Step 2: Save workspace path and commit on session
	if err := s.store.UpdateSessionWorkspace(ctx, sessionID, workspacePath, workspaceCommit); err != nil {
		log.Printf("Failed to update session workspace info for %s: %v", sessionID, err)
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("failed to save workspace info: "+err.Error()))
		return fmt.Errorf("failed to save workspace info: %w", err)
	}

	// Step 3: Create or get existing sandbox (idempotent)
	// First check if sandbox already exists (from a previous failed attempt)
	existingSandbox, err := s.sandboxProvider.Get(ctx, sessionID)
	if err != nil && !errors.Is(err, sandbox.ErrNotFound) {
		log.Printf("Failed to check for existing sandbox for session %s: %v", sessionID, err)
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("failed to check sandbox: "+err.Error()))
		return fmt.Errorf("failed to check sandbox: %w", err)
	}

	needsCreation := true
	if existingSandbox != nil {
		log.Printf("Sandbox already exists for session %s (status: %s)", sessionID, existingSandbox.Status)

		switch existingSandbox.Status {
		case sandbox.StatusRunning:
			log.Printf("Sandbox for session %s is already running", sessionID)
			needsCreation = false

		case sandbox.StatusCreated, sandbox.StatusStopped:
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusCreatingSandbox, nil)
			if err := s.sandboxProvider.Start(ctx, sessionID); err != nil {
				if !errors.Is(err, sandbox.ErrAlreadyRunning) {
					log.Printf("Sandbox start failed for session %s: %v", sessionID, err)
					s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("sandbox start failed: "+err.Error()))
					return fmt.Errorf("sandbox start failed: %w", err)
				}
			}
			needsCreation = false

		default:
			// Sandbox is in failed state - remove and recreate
			log.Printf("Removing failed sandbox for session %s", sessionID)
			if err := s.sandboxProvider.Remove(ctx, sessionID); err != nil {
				log.Printf("Warning: failed to remove old sandbox for session %s: %v", sessionID, err)
			}
		}
	}

	if needsCreation {
		// Check if image needs to be pulled and notify if so
		if !s.sandboxProvider.ImageExists(ctx) {
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusPullingImage, nil)
			log.Printf("Pulling sandbox image %s for session %s", s.sandboxProvider.Image(), sessionID)
		} else {
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusCreatingSandbox, nil)
		}

		sandboxSecret := generateSecret(32)
		opts := sandbox.CreateOptions{
			SharedSecret: sandboxSecret,
			Labels: map[string]string{
				"octobot.session.id":   sessionID,
				"octobot.workspace.id": workspace.ID,
				"octobot.project.id":   projectID,
			},
			WorkspacePath:   workspacePath,
			WorkspaceSource: workspace.Path, // Original source (git URL or local path) for WORKSPACE_PATH env var
			WorkspaceCommit: workspaceCommit,
		}

		_, err := s.sandboxProvider.Create(ctx, sessionID, opts)
		if err != nil {
			log.Printf("Sandbox creation failed for session %s: %v", sessionID, err)
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("sandbox creation failed: "+err.Error()))
			return fmt.Errorf("sandbox creation failed: %w", err)
		}

		// Start the sandbox
		if err := s.sandboxProvider.Start(ctx, sessionID); err != nil {
			log.Printf("Sandbox start failed for session %s: %v", sessionID, err)
			s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("sandbox start failed: "+err.Error()))
			return fmt.Errorf("sandbox start failed: %w", err)
		}
	}

	// Success! Update status to running
	s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusReady, nil)
	log.Printf("Session %s initialized successfully", sessionID)
	return nil
}

// updateStatusWithEvent updates session status and emits an SSE event.
func (s *SessionService) updateStatusWithEvent(ctx context.Context, projectID, sessionID, status string, errorMsg *string) {
	// Update session in database
	_, err := s.UpdateStatus(ctx, sessionID, status, errorMsg)
	if err != nil {
		log.Printf("Failed to update session %s status to %s: %v", sessionID, status, err)
	}

	// Emit SSE event
	if s.eventBroker != nil {
		// Note: We don't include commitStatus here since this is only updating session status
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, status, ""); err != nil {
			log.Printf("Failed to publish session update event: %v", err)
		}
	}
}

// generateSecret generates a cryptographically secure random hex string.
func generateSecret(length int) string {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		// Fallback to a less random but still unique value
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}

// ptrString returns a pointer to a string.
func ptrString(s string) *string {
	return &s
}

// PerformCommit performs the session commit work synchronously.
// This is called by the dispatcher when processing a session_commit job.
// The job is idempotent and handles server restart scenarios.
//
// Flow:
// 1. If pending: send /commit to agent, transition to committing
// 2. If appliedCommit not set: fetch patches from agent-api, apply to workspace
// 3. Verify applied commit exists, transition to completed
func (s *SessionService) PerformCommit(ctx context.Context, projectID, sessionID string) error {
	// Get session to check current state
	sess, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("session not found: %w", err)
	}

	// Idempotency: Skip if already completed
	if sess.CommitStatus == model.CommitStatusCompleted {
		log.Printf("Session %s commit already completed, skipping", sessionID)
		return nil
	}

	// Only proceed if session commit status is pending or committing
	if sess.CommitStatus != model.CommitStatusPending && sess.CommitStatus != model.CommitStatusCommitting {
		log.Printf("Session %s is not in pending or committing commit state (current: %s), skipping commit job", sessionID, sess.CommitStatus)
		return nil
	}

	// Verify baseCommit is set
	if sess.BaseCommit == nil || *sess.BaseCommit == "" {
		s.setCommitFailed(ctx, projectID, sess, "No base commit set")
		return nil
	}

	// Check that baseCommit still matches current workspace commit (handles server restart with workspace changes)
	gitStatus, err := s.gitProvider.Status(ctx, sess.WorkspaceID)
	if err != nil {
		s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Failed to get workspace status: %v", err))
		return nil
	}
	if gitStatus.Commit != *sess.BaseCommit {
		s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Workspace has changed since commit started (expected %s, got %s)", *sess.BaseCommit, gitStatus.Commit))
		return nil
	}

	// Step 1: Send /commit to agent (if pending)
	if sess.CommitStatus == model.CommitStatusPending {
		// Check sandbox client is available
		if s.sandboxClient == nil {
			s.setCommitFailed(ctx, projectID, sess, "Sandbox client not available")
			return nil
		}

		log.Printf("Session %s: sending /commit %s to agent", sessionID, *sess.BaseCommit)

		// Build the /commit message in UIMessage format
		commitMessage := fmt.Sprintf("/commit %s", *sess.BaseCommit)
		messages, err := buildCommitMessage(sessionID+"-commit", commitMessage)
		if err != nil {
			s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Failed to build commit message: %v", err))
			return nil
		}

		// Send the message to the agent and get SSE stream
		streamCh, err := s.sandboxClient.SendMessages(ctx, sessionID, messages, nil)
		if err != nil {
			s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Failed to send commit message to agent: %v", err))
			return nil
		}

		// Drain the stream until complete (we don't need the response content)
		for line := range streamCh {
			if line.Done {
				break
			}
			// Optionally log progress for debugging
			// log.Printf("Session %s commit stream: %s", sessionID, line.Data)
		}

		log.Printf("Session %s: /commit message completed, transitioning to committing", sessionID)

		// Transition to committing
		sess.CommitStatus = model.CommitStatusCommitting
		if err := s.store.UpdateSession(ctx, sess); err != nil {
			return fmt.Errorf("failed to update session status: %w", err)
		}
		s.publishCommitStatusChanged(ctx, projectID, sessionID, model.CommitStatusCommitting)
	}

	// Step 2: Fetch and apply patches (if not yet done)
	if sess.AppliedCommit == nil || *sess.AppliedCommit == "" {
		// Check sandbox client is available
		if s.sandboxClient == nil {
			s.setCommitFailed(ctx, projectID, sess, "Sandbox client not available")
			return nil
		}

		// Call agent-api GET /commits?parent={baseCommit} to get format-patch output
		log.Printf("Session %s: fetching commits from agent-api (parent=%s)", sessionID, *sess.BaseCommit)
		commitsResp, err := s.sandboxClient.GetCommits(ctx, sessionID, *sess.BaseCommit)
		if err != nil {
			s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Failed to get commits from agent: %v", err))
			return nil
		}

		if commitsResp.CommitCount == 0 {
			s.setCommitFailed(ctx, projectID, sess, "No commits found in agent sandbox")
			return nil
		}

		log.Printf("Session %s: received %d commits from agent, applying patches to workspace", sessionID, commitsResp.CommitCount)

		// Apply patches to workspace with git am
		finalCommit, err := s.gitProvider.ApplyPatches(ctx, sess.WorkspaceID, []byte(commitsResp.Patches))
		if err != nil {
			s.setCommitFailed(ctx, projectID, sess, fmt.Sprintf("Failed to apply patches to workspace: %v", err))
			return nil
		}

		sess.AppliedCommit = ptrString(finalCommit)
		if err := s.store.UpdateSession(ctx, sess); err != nil {
			return fmt.Errorf("failed to update session applied commit: %w", err)
		}
		s.publishCommitStatusChanged(ctx, projectID, sessionID, model.CommitStatusCommitting)
		log.Printf("Session %s: patches applied, final commit=%s", sessionID, finalCommit)
	}

	// Step 3: Verify and complete
	log.Printf("Session %s: commit completed with applied commit %s", sessionID, *sess.AppliedCommit)

	sess.CommitStatus = model.CommitStatusCompleted
	sess.CommitError = nil
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		return fmt.Errorf("failed to update session commit status: %w", err)
	}
	s.publishCommitStatusChanged(ctx, projectID, sessionID, model.CommitStatusCompleted)

	log.Printf("Session %s committed successfully", sessionID)
	return nil
}

// setCommitFailed sets the commit status to failed with an error message.
func (s *SessionService) setCommitFailed(ctx context.Context, projectID string, sess *model.Session, errorMsg string) {
	log.Printf("Session %s commit failed: %s", sess.ID, errorMsg)
	sess.CommitStatus = model.CommitStatusFailed
	sess.CommitError = ptrString(errorMsg)
	if err := s.store.UpdateSession(ctx, sess); err != nil {
		log.Printf("Failed to update session %s commit status to failed: %v", sess.ID, err)
		return
	}
	s.publishCommitStatusChanged(ctx, projectID, sess.ID, model.CommitStatusFailed)
}

// buildCommitMessage creates a UIMessage array for the /commit command.
// Returns json.RawMessage that can be passed to SendMessages.
func buildCommitMessage(msgID, text string) (json.RawMessage, error) {
	// Build the text part
	part := map[string]interface{}{
		"type": "text",
		"text": text,
	}
	parts, err := json.Marshal([]interface{}{part})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal parts: %w", err)
	}

	// Build the message
	message := map[string]interface{}{
		"id":    msgID,
		"role":  "user",
		"parts": json.RawMessage(parts),
	}
	messages, err := json.Marshal([]interface{}{message})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal messages: %w", err)
	}

	return messages, nil
}
