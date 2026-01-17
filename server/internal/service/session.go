package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/obot-platform/octobot/server/internal/events"
	"github.com/obot-platform/octobot/server/internal/git"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/store"
)

// Session represents a chat session (for API responses)
type Session struct {
	ID           string     `json:"id"`
	ProjectID    string     `json:"projectId"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	Timestamp    string     `json:"timestamp"`
	Status       string     `json:"status"`
	ErrorMessage string     `json:"errorMessage,omitempty"`
	Files        []FileNode `json:"files"`
	WorkspaceID  string     `json:"workspaceId,omitempty"`
	AgentID      string     `json:"agentId,omitempty"`
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
	eventBroker     *events.Broker
}

// NewSessionService creates a new session service
func NewSessionService(s *store.Store, gitProv git.Provider, sandboxProv sandbox.Provider, eventBroker *events.Broker) *SessionService {
	return &SessionService{
		store:           s,
		gitProvider:     gitProv,
		sandboxProvider: sandboxProv,
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

// JobEnqueuer is an interface for enqueueing session delete jobs.
type JobEnqueuer interface {
	EnqueueSessionDelete(ctx context.Context, projectID, sessionID string) error
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
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, model.SessionStatusRemoving); err != nil {
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

// PerformDeletion performs the actual session deletion work.
// This is called by the SessionDeleteExecutor job handler.
func (s *SessionService) PerformDeletion(ctx context.Context, sessionID string) error {
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

	timestamp := sess.UpdatedAt.Format(time.RFC3339)
	if sess.UpdatedAt.IsZero() {
		timestamp = time.Now().Format(time.RFC3339)
	}

	return &Session{
		ID:           sess.ID,
		ProjectID:    sess.ProjectID,
		Name:         sess.Name,
		Description:  description,
		Timestamp:    timestamp,
		Status:       sess.Status,
		ErrorMessage: errorMessage,
		Files:        []FileNode{},
		WorkspaceID:  sess.WorkspaceID,
		AgentID:      agentID,
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
	s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusRunning, nil)
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
		if err := s.eventBroker.PublishSessionUpdated(ctx, projectID, sessionID, status); err != nil {
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
