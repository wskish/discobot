package service

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/store"
)

// ContainerService manages container lifecycle for sessions.
type ContainerService struct {
	store   *store.Store
	runtime container.Runtime
	cfg     *config.Config
}

// NewContainerService creates a new container service.
func NewContainerService(s *store.Store, r container.Runtime, cfg *config.Config) *ContainerService {
	return &ContainerService{
		store:   s,
		runtime: r,
		cfg:     cfg,
	}
}

// CreateForSession creates and starts a container for the given session.
// This should be called when a session is created (eager provisioning).
func (s *ContainerService) CreateForSession(ctx context.Context, sessionID, workspacePath string) error {
	// Create container with session configuration
	opts := container.CreateOptions{
		Image:   s.cfg.ContainerImage,
		WorkDir: "/workspace",
		Labels: map[string]string{
			"octobot.session.id": sessionID,
		},
		Storage: container.StorageConfig{
			WorkspacePath: workspacePath,
			MountPath:     "/workspace",
			ReadOnly:      false,
		},
		Resources: container.ResourceConfig{
			Timeout: s.cfg.ContainerIdleTimeout,
		},
	}

	// Create the container
	_, err := s.runtime.Create(ctx, sessionID, opts)
	if err != nil {
		return fmt.Errorf("failed to create container: %w", err)
	}

	// Start the container immediately
	if err := s.runtime.Start(ctx, sessionID); err != nil {
		// Clean up on failure
		_ = s.runtime.Remove(ctx, sessionID)
		return fmt.Errorf("failed to start container: %w", err)
	}

	return nil
}

// GetForSession returns the container state for a session.
func (s *ContainerService) GetForSession(ctx context.Context, sessionID string) (*container.Container, error) {
	return s.runtime.Get(ctx, sessionID)
}

// EnsureRunning ensures a container is running for the session.
// If the container doesn't exist or is stopped, it will be created/started.
func (s *ContainerService) EnsureRunning(ctx context.Context, sessionID, workspacePath string) error {
	c, err := s.runtime.Get(ctx, sessionID)
	if err == container.ErrNotFound {
		// Container doesn't exist, create it
		return s.CreateForSession(ctx, sessionID, workspacePath)
	}
	if err != nil {
		return fmt.Errorf("failed to get container status: %w", err)
	}

	switch c.Status {
	case container.StatusRunning:
		// Already running
		return nil
	case container.StatusCreated, container.StatusStopped:
		// Start it
		return s.runtime.Start(ctx, sessionID)
	case container.StatusFailed:
		// Remove and recreate
		_ = s.runtime.Remove(ctx, sessionID)
		return s.CreateForSession(ctx, sessionID, workspacePath)
	default:
		return fmt.Errorf("unknown container status: %s", c.Status)
	}
}

// Exec runs a non-interactive command in the session's container.
func (s *ContainerService) Exec(ctx context.Context, sessionID string, cmd []string, opts container.ExecOptions) (*container.ExecResult, error) {
	return s.runtime.Exec(ctx, sessionID, cmd, opts)
}

// Attach creates an interactive PTY session to the container.
func (s *ContainerService) Attach(ctx context.Context, sessionID string, rows, cols int) (container.PTY, error) {
	opts := container.AttachOptions{
		Rows: rows,
		Cols: cols,
	}
	return s.runtime.Attach(ctx, sessionID, opts)
}

// StopForSession stops the container for a session.
func (s *ContainerService) StopForSession(ctx context.Context, sessionID string) error {
	return s.runtime.Stop(ctx, sessionID, 10*time.Second)
}

// DestroyForSession removes the container when a session is deleted.
func (s *ContainerService) DestroyForSession(ctx context.Context, sessionID string) error {
	err := s.runtime.Remove(ctx, sessionID)
	if err == container.ErrNotFound {
		// Already removed, not an error
		return nil
	}
	return err
}

// Runtime returns the underlying runtime for advanced operations.
func (s *ContainerService) Runtime() container.Runtime {
	return s.runtime
}

// ContainerEndpoint contains the information needed to communicate with a container.
type ContainerEndpoint struct {
	Port   int    // Host port mapped to container port 8080
	Secret string // Shared secret from OCTOBOT_SECRET env var
}

// GetEndpoint returns the port and secret for communicating with the session's container.
// The port is the host port mapped to container port 8080.
// The secret is the OCTOBOT_SECRET environment variable.
func (s *ContainerService) GetEndpoint(ctx context.Context, sessionID string) (*ContainerEndpoint, error) {
	c, err := s.runtime.Get(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get container: %w", err)
	}

	// Find the host port for container port 8080
	var port int
	for _, p := range c.Ports {
		if p.ContainerPort == 8080 {
			port = p.HostPort
			break
		}
	}

	if port == 0 {
		return nil, fmt.Errorf("container port 8080 not mapped")
	}

	// Get the secret from env vars
	secret := c.Env["OCTOBOT_SECRET"]
	if secret == "" {
		return nil, fmt.Errorf("OCTOBOT_SECRET not set in container")
	}

	return &ContainerEndpoint{
		Port:   port,
		Secret: secret,
	}, nil
}

// StartContainerForSessionAsync creates and starts a container asynchronously.
// Errors are logged but not returned (for use in session creation hooks).
func (s *ContainerService) StartContainerForSessionAsync(sessionID, workspacePath string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		if err := s.CreateForSession(ctx, sessionID, workspacePath); err != nil {
			log.Printf("failed to create container for session %s: %v", sessionID, err)
		}
	}()
}
