package service

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/sandbox"
	"github.com/anthropics/octobot/server/internal/store"
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
// This should be called when a session is created (eager provisioning).
func (s *SandboxService) CreateForSession(ctx context.Context, sessionID, workspacePath string) error {
	return s.CreateForSessionWithSecret(ctx, sessionID, workspacePath, "", "")
}

// CreateForSessionWithSecret creates and starts a sandbox with a shared secret.
// The secret is stored by the provider and a hashed version is made available
// to the sandbox via the OCTOBOT_SECRET environment variable.
func (s *SandboxService) CreateForSessionWithSecret(ctx context.Context, sessionID, workspacePath, sharedSecret, workspaceCommit string) error {
	// Create sandbox with session configuration
	// Note: The sandbox image is configured globally on the provider via SANDBOX_IMAGE env var
	opts := sandbox.CreateOptions{
		SharedSecret: sharedSecret,
		Labels: map[string]string{
			"octobot.session.id": sessionID,
		},
		WorkspacePath:   workspacePath,
		WorkspaceCommit: workspaceCommit,
		Resources: sandbox.ResourceConfig{
			Timeout: s.cfg.SandboxIdleTimeout,
		},
	}

	// Create the sandbox
	_, err := s.provider.Create(ctx, sessionID, opts)
	if err != nil {
		return fmt.Errorf("failed to create sandbox: %w", err)
	}

	// Start the sandbox immediately
	if err := s.provider.Start(ctx, sessionID); err != nil {
		// Clean up on failure
		_ = s.provider.Remove(ctx, sessionID)
		return fmt.Errorf("failed to start sandbox: %w", err)
	}

	return nil
}

// GetForSession returns the sandbox state for a session.
func (s *SandboxService) GetForSession(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	return s.provider.Get(ctx, sessionID)
}

// EnsureRunning ensures a sandbox is running for the session.
// If the sandbox doesn't exist or is stopped, it will be created/started.
func (s *SandboxService) EnsureRunning(ctx context.Context, sessionID, workspacePath string) error {
	sb, err := s.provider.Get(ctx, sessionID)
	if err == sandbox.ErrNotFound {
		// Sandbox doesn't exist, create it
		return s.CreateForSession(ctx, sessionID, workspacePath)
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
		// Remove and recreate
		_ = s.provider.Remove(ctx, sessionID)
		return s.CreateForSession(ctx, sessionID, workspacePath)
	default:
		return fmt.Errorf("unknown sandbox status: %s", sb.Status)
	}
}

// Exec runs a non-interactive command in the session's sandbox.
func (s *SandboxService) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	return s.provider.Exec(ctx, sessionID, cmd, opts)
}

// Attach creates an interactive PTY session to the sandbox.
func (s *SandboxService) Attach(ctx context.Context, sessionID string, rows, cols int) (sandbox.PTY, error) {
	opts := sandbox.AttachOptions{
		Rows: rows,
		Cols: cols,
	}
	return s.provider.Attach(ctx, sessionID, opts)
}

// StopForSession stops the sandbox for a session.
func (s *SandboxService) StopForSession(ctx context.Context, sessionID string) error {
	return s.provider.Stop(ctx, sessionID, 10*time.Second)
}

// DestroyForSession removes the sandbox when a session is deleted.
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

		// Get the session to find the workspace path
		session, err := s.store.GetSessionByID(ctx, sb.SessionID)
		if err != nil {
			log.Printf("Failed to get session %s, removing orphaned sandbox: %v", sb.SessionID, err)
			if err := s.provider.Remove(ctx, sb.SessionID); err != nil {
				log.Printf("Failed to remove orphaned sandbox for session %s: %v", sb.SessionID, err)
			}
			continue
		}

		// Get the workspace to find the path
		workspace, err := s.store.GetWorkspaceByID(ctx, session.WorkspaceID)
		if err != nil {
			log.Printf("Failed to get workspace %s for session %s: %v", session.WorkspaceID, sb.SessionID, err)
			continue
		}

		// Remove the old sandbox
		if err := s.provider.Remove(ctx, sb.SessionID); err != nil {
			log.Printf("Failed to remove sandbox for session %s: %v", sb.SessionID, err)
			continue
		}

		// Create a new sandbox with the correct image
		if err := s.CreateForSession(ctx, sb.SessionID, workspace.Path); err != nil {
			log.Printf("Failed to recreate sandbox for session %s: %v", sb.SessionID, err)
			continue
		}

		log.Printf("Successfully recreated sandbox for session %s with image %s", sb.SessionID, expectedImage)
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
