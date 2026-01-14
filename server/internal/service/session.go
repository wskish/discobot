package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/events"
	"github.com/anthropics/octobot/server/internal/git"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
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
	store            *store.Store
	gitProvider      git.Provider
	containerRuntime container.Runtime
	eventBroker      *events.Broker
}

// NewSessionService creates a new session service
func NewSessionService(s *store.Store, gitProv git.Provider, containerRT container.Runtime, eventBroker *events.Broker) *SessionService {
	return &SessionService{
		store:            s,
		gitProvider:      gitProv,
		containerRuntime: containerRT,
		eventBroker:      eventBroker,
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

// CreateSession creates a new session with initializing status.
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

// DeleteSession deletes a session
func (s *SessionService) DeleteSession(ctx context.Context, sessionID string) error {
	return s.store.DeleteSession(ctx, sessionID)
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
	if s.gitProvider == nil || s.containerRuntime == nil {
		return fmt.Errorf("runtime dependencies not set")
	}

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
		s.updateStatusWithEvent(ctx, session.ProjectID, sessionID, model.SessionStatusError, ptrString("agent not found: "+err.Error()))
		return fmt.Errorf("agent not found: %w", err)
	}

	// Run initialization synchronously
	return s.initializeSync(ctx, session.ProjectID, session, workspace, agent)
}

// initializeSync runs the initialization flow synchronously.
func (s *SessionService) initializeSync(
	ctx context.Context,
	projectID string,
	session *Session,
	workspace *model.Workspace,
	agent *model.Agent,
) error {
	sessionID := session.ID

	// Track results from parallel operations
	var wg sync.WaitGroup
	var cloneErr, containerErr error
	var workDir string

	// Only clone if it's a git workspace
	isGit := workspace.SourceType == "git" || git.IsGitURL(workspace.Path)

	// Start parallel operations
	wg.Add(2)

	// Git clone goroutine
	go func() {
		defer wg.Done()

		if !isGit {
			// Skip cloning for local workspaces
			workDir = workspace.Path
			return
		}

		// Update status to cloning
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusCloning, nil)

		workDir, _, cloneErr = s.gitProvider.EnsureWorkspace(ctx, projectID, workspace.ID, workspace.Path, "")
		if cloneErr != nil {
			log.Printf("Git clone failed for session %s: %v", sessionID, cloneErr)
		}
	}()

	// Generate a shared secret for container communication
	containerSecret := generateSecret(32)

	// Container creation goroutine
	go func() {
		defer wg.Done()

		// Update status to creating_container
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusCreatingContainer, nil)

		// Create container with "echo hi; sleep infinity" command for now
		opts := container.CreateOptions{
			Image:   "ubuntu:24.04",
			Cmd:     []string{"/bin/sh", "-c", "echo hi; sleep infinity"},
			WorkDir: "/workspace",
			Labels: map[string]string{
				"octobot.session.id":   sessionID,
				"octobot.workspace.id": workspace.ID,
				"octobot.project.id":   projectID,
			},
			Env: map[string]string{
				"OCTOBOT_SECRET": containerSecret,
			},
			// Expose port 8080 on a random host port
			Ports: []container.PortMapping{
				{
					ContainerPort: 8080,
					HostPort:      0, // Random port
					Protocol:      "tcp",
				},
			},
		}

		// We'll set up storage after git clone completes
		_, containerErr = s.containerRuntime.Create(ctx, sessionID, opts)
		if containerErr != nil {
			log.Printf("Container creation failed for session %s: %v", sessionID, containerErr)
			return
		}

		// Start the container
		if err := s.containerRuntime.Start(ctx, sessionID); err != nil {
			containerErr = fmt.Errorf("failed to start container: %w", err)
			log.Printf("Container start failed for session %s: %v", sessionID, err)
		}
	}()

	// Wait for both to complete
	wg.Wait()

	// Check for errors
	if cloneErr != nil {
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("git clone failed: "+cloneErr.Error()))
		return fmt.Errorf("git clone failed: %w", cloneErr)
	}
	if containerErr != nil {
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("container creation failed: "+containerErr.Error()))
		return fmt.Errorf("container creation failed: %w", containerErr)
	}

	// Update status to starting_agent
	s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusStartingAgent, nil)

	// Prepare session config to send to agent
	config := SessionConfig{
		Session: session,
		Workspace: &Workspace{
			ID:         workspace.ID,
			Path:       workDir, // Use the cloned path
			SourceType: workspace.SourceType,
		},
	}
	if agent != nil {
		config.Agent = &Agent{
			ID:          agent.ID,
			Name:        agent.Name,
			AgentType:   agent.AgentType,
			Description: derefString(agent.Description),
		}
	}

	// Run agent start command ("cat" for now) with config as stdin
	configJSON, err := json.Marshal(config)
	if err != nil {
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("failed to marshal config: "+err.Error()))
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	execOpts := container.ExecOptions{
		WorkDir: "/workspace",
		Stdin:   bytes.NewReader(configJSON),
	}

	result, err := s.containerRuntime.Exec(ctx, sessionID, []string{"cat"}, execOpts)
	if err != nil {
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString("agent start failed: "+err.Error()))
		return fmt.Errorf("agent start failed: %w", err)
	}

	if result.ExitCode != 0 {
		errMsg := fmt.Sprintf("agent start exited with code %d: %s", result.ExitCode, string(result.Stderr))
		s.updateStatusWithEvent(ctx, projectID, sessionID, model.SessionStatusError, ptrString(errMsg))
		return fmt.Errorf("%s", errMsg)
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

// derefString dereferences a string pointer, returning empty string if nil.
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
