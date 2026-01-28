package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"time"

	"github.com/obot-platform/octobot/server/internal/config"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/store"
)

// SandboxService manages sandbox lifecycle for sessions.
type SandboxService struct {
	store    *store.Store
	provider sandbox.Provider
	cfg      *config.Config
}

// NewSandboxService creates a new sandbox service.
func NewSandboxService(s *store.Store, p sandbox.Provider, cfg *config.Config) *SandboxService {
	return &SandboxService{
		store:    s,
		provider: p,
		cfg:      cfg,
	}
}

// CreateForSession creates and starts a sandbox for the given session.
// It retrieves the workspace path and commit from the session in the database
// and generates a cryptographically secure shared secret.
func (s *SandboxService) CreateForSession(ctx context.Context, sessionID string) error {
	// Get session to retrieve workspace path and commit
	session, err := s.store.GetSessionByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("failed to get session: %w", err)
	}

	// Workspace path should be set during session initialization
	workspacePath := ""
	if session.WorkspacePath != nil {
		workspacePath = *session.WorkspacePath
	}
	if workspacePath == "" {
		return fmt.Errorf("session %s has no workspace path set", sessionID)
	}

	// Workspace commit may be empty for local (non-git) workspaces
	workspaceCommit := ""
	if session.WorkspaceCommit != nil {
		workspaceCommit = *session.WorkspaceCommit
	}

	// Generate a cryptographically secure shared secret
	sharedSecret := generateSandboxSecret(32)

	// Create sandbox with session configuration
	// Note: The sandbox image is configured globally on the provider via SANDBOX_IMAGE env var
	opts := sandbox.CreateOptions{
		SharedSecret: sharedSecret,
		Labels: map[string]string{
			"octobot.session.id":   sessionID,
			"octobot.workspace.id": session.WorkspaceID,
			"octobot.project.id":   session.ProjectID,
		},
		WorkspacePath:   workspacePath,
		WorkspaceCommit: workspaceCommit,
		Resources: sandbox.ResourceConfig{
			Timeout: s.cfg.SandboxIdleTimeout,
		},
	}

	// Create the sandbox
	_, err = s.provider.Create(ctx, sessionID, opts)
	if err != nil {
		return fmt.Errorf("failed to create sandbox: %w", err)
	}

	// Start the sandbox immediately
	if err := s.provider.Start(ctx, sessionID); err != nil {
		// Clean up on failure (don't need to remove volumes since this is a new sandbox)
		_ = s.provider.Remove(ctx, sessionID)
		return fmt.Errorf("failed to start sandbox: %w", err)
	}

	return nil
}

// generateSandboxSecret generates a cryptographically secure random hex string.
func generateSandboxSecret(length int) string {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		// Fallback to a less random but still unique value
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}

// GetForSession returns the sandbox state for a session.
func (s *SandboxService) GetForSession(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	return s.provider.Get(ctx, sessionID)
}

// EnsureRunning ensures a sandbox is running for the session.
// If the sandbox doesn't exist or is stopped, it will be created/started.
func (s *SandboxService) EnsureRunning(ctx context.Context, sessionID string) error {
	sb, err := s.provider.Get(ctx, sessionID)
	if err == sandbox.ErrNotFound {
		// Sandbox doesn't exist, create it
		return s.CreateForSession(ctx, sessionID)
	}
	if err != nil {
		return fmt.Errorf("failed to get sandbox status: %w", err)
	}

	switch sb.Status {
	case sandbox.StatusRunning:
		// Already running
		return nil
	case sandbox.StatusCreated, sandbox.StatusStopped:
		// Start it
		return s.provider.Start(ctx, sessionID)
	case sandbox.StatusFailed:
		// Remove and recreate (preserve volumes for potential data recovery)
		_ = s.provider.Remove(ctx, sessionID)
		return s.CreateForSession(ctx, sessionID)
	default:
		return fmt.Errorf("unknown sandbox status: %s", sb.Status)
	}
}

// Exec runs a non-interactive command in the session's sandbox.
func (s *SandboxService) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	return s.provider.Exec(ctx, sessionID, cmd, opts)
}

// Attach creates an interactive PTY session to the sandbox.
// If user is empty, the container's default user is used.
func (s *SandboxService) Attach(ctx context.Context, sessionID string, rows, cols int, user string) (sandbox.PTY, error) {
	opts := sandbox.AttachOptions{
		Rows: rows,
		Cols: cols,
		User: user,
	}
	return s.provider.Attach(ctx, sessionID, opts)
}

// GetUserInfo retrieves the default user info from the sandbox.
// Returns username, UID, and GID for terminal sessions.
func (s *SandboxService) GetUserInfo(ctx context.Context, sessionID string) (username string, uid, gid int, err error) {
	// Create ad-hoc client without credential fetcher - user info doesn't need credentials
	client := NewSandboxChatClient(s.provider, nil)
	userInfo, err := client.GetUserInfo(ctx, sessionID)
	if err != nil {
		return "", 0, 0, err
	}
	return userInfo.Username, userInfo.UID, userInfo.GID, nil
}

// StopForSession stops the sandbox for a session.
func (s *SandboxService) StopForSession(ctx context.Context, sessionID string) error {
	return s.provider.Stop(ctx, sessionID, 10*time.Second)
}

// DestroyForSession removes the sandbox when a session is deleted.
// This is deprecated - use SessionService.PerformDeletion instead which handles volumes.
func (s *SandboxService) DestroyForSession(ctx context.Context, sessionID string) error {
	err := s.provider.Remove(ctx, sessionID)
	if err == sandbox.ErrNotFound {
		// Already removed, not an error
		return nil
	}
	return err
}

// Provider returns the underlying provider for advanced operations.
func (s *SandboxService) Provider() sandbox.Provider {
	return s.provider
}

// ReconcileSandboxes checks all existing sandboxes and recreates any that
// are using an outdated image. This should be called on server startup.
func (s *SandboxService) ReconcileSandboxes(ctx context.Context) error {
	expectedImage := s.provider.Image()
	if expectedImage == "" {
		log.Printf("No sandbox image configured, skipping reconciliation")
		return nil
	}

	sandboxes, err := s.provider.List(ctx)
	if err != nil {
		return fmt.Errorf("failed to list sandboxes: %w", err)
	}

	log.Printf("Reconciling %d sandboxes (expected image: %s)", len(sandboxes), expectedImage)

	for _, sb := range sandboxes {
		// Check if the sandbox uses the expected image
		if sb.Image == expectedImage {
			log.Printf("Sandbox for session %s uses correct image", sb.SessionID)
			continue
		}

		log.Printf("Sandbox for session %s uses outdated image %s (expected %s), recreating...",
			sb.SessionID, sb.Image, expectedImage)

		// Check if the session exists; if not, remove orphaned sandbox
		_, err := s.store.GetSessionByID(ctx, sb.SessionID)
		if err != nil {
			log.Printf("Failed to get session %s, removing orphaned sandbox: %v", sb.SessionID, err)
			// Preserve volumes for orphaned sandboxes in case of recovery
			if err := s.provider.Remove(ctx, sb.SessionID); err != nil {
				log.Printf("Failed to remove orphaned sandbox for session %s: %v", sb.SessionID, err)
			}
			continue
		}

		// Remove the old sandbox (preserve volume for image update)
		if err := s.provider.Remove(ctx, sb.SessionID); err != nil {
			log.Printf("Failed to remove sandbox for session %s: %v", sb.SessionID, err)
			continue
		}

		// Create a new sandbox with the correct image
		// CreateForSession will retrieve workspace path and commit from the session
		if err := s.CreateForSession(ctx, sb.SessionID); err != nil {
			log.Printf("Failed to recreate sandbox for session %s: %v", sb.SessionID, err)
			continue
		}

		log.Printf("Successfully recreated sandbox for session %s with image %s", sb.SessionID, expectedImage)
	}

	return nil
}

// ReconcileSessionStates checks sessions that the database considers active or
// in-progress and verifies their sandbox state matches. If a sandbox has failed,
// the session is marked as error. If the sandbox is stopped or doesn't exist,
// the session is marked as stopped. For sessions marked "running", checks with
// the agent API to verify a chat is actually in progress. This should be called
// on server startup after ReconcileSandboxes.
//
// This handles three cases:
//  1. Sessions marked "ready" or "running" but sandbox is missing/stopped/failed
//  2. Sessions marked "running" but no completion is actually in progress
//  3. Sessions stuck in intermediate states (initializing, creating_sandbox, etc.)
//     where the server died mid-creation and the sandbox doesn't exist
func (s *SandboxService) ReconcileSessionStates(ctx context.Context) error {
	// Get all sessions that need reconciliation:
	// - "ready" or "running" sessions where sandbox might have died
	// - intermediate states where server might have died mid-creation
	statesToReconcile := []string{
		model.SessionStatusReady,
		model.SessionStatusRunning,
		model.SessionStatusInitializing,
		model.SessionStatusReinitializing,
		model.SessionStatusCloning,
		model.SessionStatusPullingImage,
		model.SessionStatusCreatingSandbox,
	}

	activeSessions, err := s.store.ListSessionsByStatuses(ctx, statesToReconcile)
	if err != nil {
		return fmt.Errorf("failed to list active sessions: %w", err)
	}

	log.Printf("Reconciling state for %d active/in-progress sessions", len(activeSessions))

	for _, session := range activeSessions {
		sb, err := s.provider.Get(ctx, session.ID)
		if err == sandbox.ErrNotFound {
			// Sandbox doesn't exist - mark as stopped, will be recreated on demand
			log.Printf("Session %s (status: %s) has no sandbox, marking as stopped", session.ID, session.Status)
			if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusStopped, nil); err != nil {
				log.Printf("Failed to update session %s status: %v", session.ID, err)
			}
			continue
		}
		if err != nil {
			log.Printf("Failed to get sandbox for session %s: %v", session.ID, err)
			continue
		}

		// Check if sandbox is in a failed state
		if sb.Status == sandbox.StatusFailed {
			log.Printf("Session %s has failed sandbox (error: %s), marking session as error", session.ID, sb.Error)
			errMsg := fmt.Sprintf("Sandbox failed: %s", sb.Error)
			if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusError, &errMsg); err != nil {
				log.Printf("Failed to update session %s status: %v", session.ID, err)
			}
			continue
		}

		// Check if sandbox is stopped or just created (not running)
		if sb.Status == sandbox.StatusStopped || sb.Status == sandbox.StatusCreated {
			log.Printf("Session %s has %s sandbox, marking as stopped", session.ID, sb.Status)
			if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusStopped, nil); err != nil {
				log.Printf("Failed to update session %s status: %v", session.ID, err)
			}
			continue
		}

		// Sandbox exists and is running
		if sb.Status == sandbox.StatusRunning {
			// Special handling for "running" sessions - verify chat is actually in progress
			if session.Status == model.SessionStatusRunning {
				// Check with agent API if completion is actually running
				client := NewSandboxChatClient(s.provider, nil)
				chatStatus, err := client.GetChatStatus(ctx, session.ID)
				if err != nil {
					// Failed to get chat status - assume chat is not running
					// This handles cases where the sandbox doesn't have the agent API
					// or the agent API is not responding
					log.Printf("Failed to get chat status for session %s (assuming not running): %v", session.ID, err)
					log.Printf("Session %s marked as running but chat status unavailable, updating to ready", session.ID)
					if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusReady, nil); err != nil {
						log.Printf("Failed to update session %s status: %v", session.ID, err)
					}
					continue
				}

				if !chatStatus.IsRunning {
					// Chat is not actually running - reset to ready
					log.Printf("Session %s marked as running but chat not active, updating to ready", session.ID)
					if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusReady, nil); err != nil {
						log.Printf("Failed to update session %s status: %v", session.ID, err)
					}
				} else {
					completionID := "unknown"
					if chatStatus.CompletionID != nil {
						completionID = *chatStatus.CompletionID
					}
					log.Printf("Session %s chat is running (completion: %s)", session.ID, completionID)
				}
				continue
			}

			// Update session status if it was in intermediate state
			if session.Status != model.SessionStatusReady {
				log.Printf("Session %s was in %s state but sandbox is running, updating to ready", session.ID, session.Status)
				if err := s.store.UpdateSessionStatus(ctx, session.ID, model.SessionStatusReady, nil); err != nil {
					log.Printf("Failed to update session %s status: %v", session.ID, err)
				}
			}
			continue
		}

		log.Printf("Session %s (status: %s) sandbox status: %s", session.ID, session.Status, sb.Status)
	}

	return nil
}

// SandboxEndpoint contains the information needed to communicate with a sandbox.
type SandboxEndpoint struct {
	Port   int    // Host port mapped to sandbox port 3002
	Secret string // Raw shared secret (use for authentication)
}

// GetEndpoint returns the port and secret for communicating with the session's sandbox.
// The port is the host port mapped to sandbox port 3002.
// The secret is the raw shared secret stored during sandbox creation.
func (s *SandboxService) GetEndpoint(ctx context.Context, sessionID string) (*SandboxEndpoint, error) {
	sb, err := s.provider.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sandbox: %w", err)
	}

	// Find the host port for sandbox port 3002
	var port int
	for _, p := range sb.Ports {
		if p.ContainerPort == 3002 {
			port = p.HostPort
			break
		}
	}

	if port == 0 {
		return nil, fmt.Errorf("sandbox port 3002 not mapped")
	}

	// Get the raw secret from the provider
	secret, err := s.provider.GetSecret(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sandbox secret: %w", err)
	}

	return &SandboxEndpoint{
		Port:   port,
		Secret: secret,
	}, nil
}
