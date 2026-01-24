// Package docker provides a Docker-based sandbox provider.
package docker

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/obot-platform/octobot/server/internal/config"
)

// DinD naming conventions
const (
	dindContainerPrefix = "octobot-dind-"
	dindVolumePrefix    = "octobot-dind-sock-"
)

// DinDManager manages per-project Docker-in-Docker daemon containers.
// Each project gets its own DinD daemon that shares its Docker socket
// with all session containers in that project.
type DinDManager struct {
	client *client.Client
	cfg    *config.Config
	mu     sync.RWMutex

	// Track active project DinD daemons
	daemons map[string]*dindState // projectID -> state
}

// dindState tracks the state of a DinD daemon for a project.
type dindState struct {
	containerID string
	volumeName  string
	ready       bool
}

// NewDinDManager creates a new DinD manager.
func NewDinDManager(cli *client.Client, cfg *config.Config) *DinDManager {
	return &DinDManager{
		client:  cli,
		cfg:     cfg,
		daemons: make(map[string]*dindState),
	}
}

// dindContainerName returns the container name for a project's DinD daemon.
func dindContainerName(projectID string) string {
	return dindContainerPrefix + projectID
}

// dindVolumeName returns the volume name for a project's DinD socket.
func dindVolumeName(projectID string) string {
	return dindVolumePrefix + projectID
}

// EnsureDaemon ensures a DinD daemon is running for the project.
// Returns the volume name containing the Docker socket.
// This method is idempotent - if the daemon is already running, it returns immediately.
func (m *DinDManager) EnsureDaemon(ctx context.Context, projectID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if we already have a running daemon for this project
	if state, exists := m.daemons[projectID]; exists && state.ready {
		return state.volumeName, nil
	}

	// Check if a daemon container already exists (from a previous server run)
	containerName := dindContainerName(projectID)
	existing, err := m.client.ContainerInspect(ctx, containerName)
	if err == nil && existing.State != nil {
		// Container exists
		volName := dindVolumeName(projectID)
		if existing.State.Running {
			// Already running, just update our state
			m.daemons[projectID] = &dindState{
				containerID: existing.ID,
				volumeName:  volName,
				ready:       true,
			}
			return volName, nil
		}
		// Container exists but not running - start it
		if err := m.client.ContainerStart(ctx, existing.ID, container.StartOptions{}); err != nil {
			return "", fmt.Errorf("failed to start existing DinD daemon: %w", err)
		}
		// Wait for daemon to be ready
		if err := m.waitForReady(ctx, existing.ID); err != nil {
			return "", fmt.Errorf("DinD daemon failed to become ready: %w", err)
		}
		m.daemons[projectID] = &dindState{
			containerID: existing.ID,
			volumeName:  volName,
			ready:       true,
		}
		return volName, nil
	}

	// Create new daemon
	volName, containerID, err := m.createDaemon(ctx, projectID)
	if err != nil {
		return "", err
	}

	// Wait for daemon to be ready
	if err := m.waitForReady(ctx, containerID); err != nil {
		// Cleanup on failure
		_ = m.client.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true})
		return "", fmt.Errorf("DinD daemon failed to become ready: %w", err)
	}

	m.daemons[projectID] = &dindState{
		containerID: containerID,
		volumeName:  volName,
		ready:       true,
	}

	log.Printf("DinD daemon ready for project %s (container: %s)", projectID, containerID[:12])
	return volName, nil
}

// createDaemon creates a new DinD daemon container for the project.
// Returns the volume name and container ID.
func (m *DinDManager) createDaemon(ctx context.Context, projectID string) (string, string, error) {
	containerName := dindContainerName(projectID)
	volName := dindVolumeName(projectID)

	// Create volume for Docker socket sharing
	_, err := m.client.VolumeCreate(ctx, volume.CreateOptions{
		Name: volName,
		Labels: map[string]string{
			"octobot.project.id": projectID,
			"octobot.managed":    "true",
			"octobot.dind":       "true",
		},
	})
	if err != nil {
		return "", "", fmt.Errorf("failed to create DinD volume: %w", err)
	}

	// Pull DinD image if needed
	if err := m.ensureImage(ctx); err != nil {
		return "", "", fmt.Errorf("failed to ensure DinD image: %w", err)
	}

	// Create container configuration
	// Configure dockerd to set socket group to GID 1000 (octobot user's group)
	containerConfig := &container.Config{
		Image:    m.cfg.DinDImage,
		Hostname: "dind",
		Labels: map[string]string{
			"octobot.project.id": projectID,
			"octobot.managed":    "true",
			"octobot.dind":       "true",
		},
		Cmd: []string{"--group", "1000"},
	}

	hostConfig := &container.HostConfig{
		// DinD requires privileged mode
		Privileged: true,
		// Mount volume at /var/run for socket sharing
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: volName,
				Target: "/var/run",
			},
		},
		// Auto-restart the daemon
		RestartPolicy: container.RestartPolicy{
			Name: container.RestartPolicyUnlessStopped,
		},
	}

	// Attach to custom network if configured
	if m.cfg.DockerNetwork != "" {
		hostConfig.NetworkMode = container.NetworkMode(m.cfg.DockerNetwork)
	}

	// Create the container
	resp, err := m.client.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, containerName)
	if err != nil {
		// Cleanup volume on failure
		_ = m.client.VolumeRemove(ctx, volName, true)
		return "", "", fmt.Errorf("failed to create DinD container: %w", err)
	}

	// Start the container
	if err := m.client.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = m.client.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		_ = m.client.VolumeRemove(ctx, volName, true)
		return "", "", fmt.Errorf("failed to start DinD container: %w", err)
	}

	log.Printf("Created DinD daemon for project %s (container: %s)", projectID, resp.ID[:12])
	return volName, resp.ID, nil
}

// ensureImage ensures the DinD image is available locally.
func (m *DinDManager) ensureImage(ctx context.Context) error {
	// Check if image exists locally
	_, err := m.client.ImageInspect(ctx, m.cfg.DinDImage)
	if err == nil {
		return nil // Image exists
	}

	// Pull the image
	log.Printf("Pulling DinD image: %s", m.cfg.DinDImage)
	reader, err := m.client.ImagePull(ctx, m.cfg.DinDImage, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("failed to pull DinD image: %w", err)
	}
	defer reader.Close()

	// Wait for pull to complete by reading the output
	buf := make([]byte, 1024)
	for {
		_, err := reader.Read(buf)
		if err != nil {
			break
		}
	}

	return nil
}

// waitForReady waits for the DinD daemon to be ready to accept connections.
// It does this by repeatedly executing "docker info" inside the container
// until it succeeds or times out.
func (m *DinDManager) waitForReady(ctx context.Context, containerID string) error {
	// Create a context with timeout
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Retry loop with exponential backoff
	for attempt := 0; attempt < 60; attempt++ {
		// Execute "docker info" to check if daemon is ready
		execConfig := container.ExecOptions{
			Cmd:          []string{"docker", "info"},
			AttachStdout: true,
			AttachStderr: true,
		}

		execResp, err := m.client.ContainerExecCreate(ctx, containerID, execConfig)
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}

		// Start the exec
		attachResp, err := m.client.ContainerExecAttach(ctx, execResp.ID, container.ExecStartOptions{})
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}
		attachResp.Close()

		// Check exit code
		inspectResp, err := m.client.ContainerExecInspect(ctx, execResp.ID)
		if err != nil {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(100 * time.Millisecond):
				continue
			}
		}

		if inspectResp.ExitCode == 0 {
			// Docker daemon is ready
			// Socket is owned by GID 1000 (octobot user's group) via --group flag
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
			// Continue retrying
		}
	}

	return fmt.Errorf("DinD daemon did not become ready within timeout")
}


// RecoverDaemons ensures DinD daemons are running for any projects that have
// active session containers. This reconciles the DinD state on server restart.
func (m *DinDManager) RecoverDaemons(ctx context.Context) error {
	// Find all running session containers to determine which projects need DinD
	sessionContainers, err := m.client.ContainerList(ctx, container.ListOptions{
		Filters: filters.NewArgs(
			filters.Arg("label", "octobot.managed=true"),
			filters.Arg("label", "octobot.session.id"),
			filters.Arg("status", "running"),
		),
	})
	if err != nil {
		return fmt.Errorf("failed to list session containers: %w", err)
	}

	// Collect unique project IDs that have running sessions
	projectIDs := make(map[string]bool)
	for _, c := range sessionContainers {
		projectID := c.Labels["octobot.project.id"]
		if projectID != "" {
			projectIDs[projectID] = true
		}
	}

	if len(projectIDs) == 0 {
		log.Printf("No running session containers found, skipping DinD recovery")
		return nil
	}

	// Ensure DinD daemon is running for each project with active sessions
	log.Printf("Found %d projects with running sessions, ensuring DinD daemons...", len(projectIDs))
	for projectID := range projectIDs {
		if _, err := m.EnsureDaemon(ctx, projectID); err != nil {
			log.Printf("Warning: failed to ensure DinD daemon for project %s: %v", projectID, err)
		} else {
			log.Printf("DinD daemon ready for project %s", projectID)
		}
	}

	return nil
}

// StopDaemon stops and removes a project's DinD daemon.
func (m *DinDManager) StopDaemon(ctx context.Context, projectID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	state, exists := m.daemons[projectID]
	if !exists {
		return nil // Nothing to stop
	}

	// Stop the container
	timeout := 10
	if err := m.client.ContainerStop(ctx, state.containerID, container.StopOptions{Timeout: &timeout}); err != nil {
		log.Printf("Warning: failed to stop DinD container for project %s: %v", projectID, err)
	}

	// Remove the container
	if err := m.client.ContainerRemove(ctx, state.containerID, container.RemoveOptions{Force: true}); err != nil {
		log.Printf("Warning: failed to remove DinD container for project %s: %v", projectID, err)
	}

	// Remove the volume
	if err := m.client.VolumeRemove(ctx, state.volumeName, true); err != nil {
		log.Printf("Warning: failed to remove DinD volume for project %s: %v", projectID, err)
	}

	delete(m.daemons, projectID)
	log.Printf("Stopped DinD daemon for project %s", projectID)
	return nil
}

// StopAll stops all DinD daemons (for server shutdown).
func (m *DinDManager) StopAll(ctx context.Context) error {
	m.mu.Lock()
	projectIDs := make([]string, 0, len(m.daemons))
	for pid := range m.daemons {
		projectIDs = append(projectIDs, pid)
	}
	m.mu.Unlock()

	for _, pid := range projectIDs {
		if err := m.StopDaemon(ctx, pid); err != nil {
			log.Printf("Warning: failed to stop DinD daemon for project %s: %v", pid, err)
		}
	}

	return nil
}

// GetDaemonState returns the state of a project's DinD daemon.
// Returns nil if no daemon exists for the project.
func (m *DinDManager) GetDaemonState(projectID string) *dindState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.daemons[projectID]
}

// Watch monitors Docker events for DinD container changes.
// When a DinD container is stopped or destroyed externally, it clears the
// cached state so the daemon will be recreated on next use.
// This method blocks until the context is cancelled.
func (m *DinDManager) Watch(ctx context.Context) error {
	log.Println("Starting DinD container watcher")

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		// Set up filter for DinD containers only
		filterArgs := filters.NewArgs(
			filters.Arg("type", string(events.ContainerEventType)),
			filters.Arg("label", "octobot.dind=true"),
		)

		// Watch Docker events
		msgCh, errCh := m.client.Events(ctx, events.ListOptions{
			Filters: filterArgs,
		})

		// Process events until error or context cancellation
		if !m.processEvents(ctx, msgCh, errCh) {
			return ctx.Err()
		}

		// Recoverable error - wait before reconnecting
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
			log.Println("DinD watcher: reconnecting to Docker events...")
		}
	}
}

// processEvents handles Docker events for DinD containers.
// Returns false if context was cancelled, true if reconnection should be attempted.
func (m *DinDManager) processEvents(ctx context.Context, msgCh <-chan events.Message, errCh <-chan error) bool {
	for {
		select {
		case <-ctx.Done():
			return false

		case err := <-errCh:
			if err == nil {
				return true // Channel closed, reconnect
			}
			if ctx.Err() != nil {
				return false
			}
			log.Printf("DinD watcher: Docker events error: %v", err)
			return true

		case msg := <-msgCh:
			m.handleEvent(msg)
		}
	}
}

// handleEvent processes a single Docker event for a DinD container.
func (m *DinDManager) handleEvent(msg events.Message) {
	projectID := msg.Actor.Attributes["octobot.project.id"]
	if projectID == "" {
		return
	}

	switch msg.Action {
	case "die", "destroy", "kill", "stop":
		m.mu.Lock()
		shouldRecreate := false
		if state, exists := m.daemons[projectID]; exists {
			state.ready = false
			shouldRecreate = true
		}
		m.mu.Unlock()

		// Recreate the daemon immediately in a goroutine
		if shouldRecreate {
			log.Printf("DinD watcher: daemon for project %s stopped/destroyed, recreating...", projectID)
			go func(pid string) {
				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				if _, err := m.EnsureDaemon(ctx, pid); err != nil {
					log.Printf("DinD watcher: failed to recreate daemon for project %s: %v", pid, err)
				} else {
					log.Printf("DinD watcher: daemon for project %s recreated successfully", pid)
				}
			}(projectID)
		}

	case "start":
		m.mu.Lock()
		if state, exists := m.daemons[projectID]; exists {
			state.ready = true
			log.Printf("DinD watcher: daemon for project %s started", projectID)
		}
		m.mu.Unlock()
	}
}
