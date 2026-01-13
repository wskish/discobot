// Package docker provides a Docker-based implementation of the container.Runtime interface.
package docker

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	containerTypes "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/container"
)

// Provider implements the container.Runtime interface using Docker.
type Provider struct {
	client *client.Client
	cfg    *config.Config

	// containerIDs maps sessionID -> Docker container ID
	containerIDs   map[string]string
	containerIDsMu sync.RWMutex
}

// NewProvider creates a new Docker runtime provider.
func NewProvider(cfg *config.Config) (*Provider, error) {
	opts := []client.Opt{
		client.FromEnv,
		client.WithAPIVersionNegotiation(),
	}

	if cfg.DockerHost != "" {
		opts = append(opts, client.WithHost(cfg.DockerHost))
	}

	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to create docker client: %w", err)
	}

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if _, err := cli.Ping(ctx); err != nil {
		cli.Close()
		return nil, fmt.Errorf("failed to connect to docker daemon: %w", err)
	}

	return &Provider{
		client:       cli,
		cfg:          cfg,
		containerIDs: make(map[string]string),
	}, nil
}

// containerName generates a consistent container name from session ID.
func containerName(sessionID string) string {
	return fmt.Sprintf("octobot-session-%s", sessionID)
}

// Create creates a new Docker container for the given session.
func (p *Provider) Create(ctx context.Context, sessionID string, opts container.CreateOptions) (*container.Container, error) {
	// Check if container already exists
	p.containerIDsMu.RLock()
	if _, exists := p.containerIDs[sessionID]; exists {
		p.containerIDsMu.RUnlock()
		return nil, container.ErrAlreadyExists
	}
	p.containerIDsMu.RUnlock()

	name := containerName(sessionID)

	// Check if container exists by name (from previous runs)
	if existing, _ := p.client.ContainerInspect(ctx, name); existing.ID != "" {
		// Remove existing container
		_ = p.client.ContainerRemove(ctx, existing.ID, containerTypes.RemoveOptions{Force: true})
	}

	// Prepare image
	image := opts.Image
	if image == "" {
		image = p.cfg.ContainerImage
	}

	// Convert environment variables to slice
	var env []string
	for k, v := range opts.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	// Prepare labels
	labels := map[string]string{
		"octobot.session.id": sessionID,
		"octobot.managed":    "true",
	}
	for k, v := range opts.Labels {
		labels[k] = v
	}

	// Container configuration
	containerConfig := &containerTypes.Config{
		Image:        image,
		Cmd:          opts.Cmd, // Use provided command or image default if empty
		Env:          env,
		Labels:       labels,
		Tty:          true,
		OpenStdin:    true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		WorkingDir:   opts.WorkDir,
	}

	// Host configuration with resource limits
	hostConfig := &containerTypes.HostConfig{}

	// Apply resource limits
	if opts.Resources.MemoryMB > 0 {
		hostConfig.Memory = int64(opts.Resources.MemoryMB) * 1024 * 1024
	}
	if opts.Resources.CPUCores > 0 {
		hostConfig.NanoCPUs = int64(opts.Resources.CPUCores * 1e9)
	}

	// Configure storage mount
	if opts.Storage.WorkspacePath != "" && opts.Storage.MountPath != "" {
		hostConfig.Mounts = append(hostConfig.Mounts, mount.Mount{
			Type:     mount.TypeBind,
			Source:   opts.Storage.WorkspacePath,
			Target:   opts.Storage.MountPath,
			ReadOnly: opts.Storage.ReadOnly,
		})
	}

	// Configure network
	if p.cfg.DockerNetwork != "" {
		hostConfig.NetworkMode = containerTypes.NetworkMode(p.cfg.DockerNetwork)
	}

	// Create container
	resp, err := p.client.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, name)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrStartFailed, err)
	}

	// Store mapping
	p.containerIDsMu.Lock()
	p.containerIDs[sessionID] = resp.ID
	p.containerIDsMu.Unlock()

	now := time.Now()
	return &container.Container{
		ID:        resp.ID,
		SessionID: sessionID,
		Status:    container.StatusCreated,
		Image:     image,
		CreatedAt: now,
		Metadata: map[string]string{
			"name": name,
		},
	}, nil
}

// Start starts a previously created container.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return err
	}

	if err := p.client.ContainerStart(ctx, containerID, containerTypes.StartOptions{}); err != nil {
		return fmt.Errorf("%w: %v", container.ErrStartFailed, err)
	}

	return nil
}

// Stop stops a running container gracefully.
func (p *Provider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return err
	}

	timeoutSeconds := int(timeout.Seconds())
	stopOptions := containerTypes.StopOptions{
		Timeout: &timeoutSeconds,
	}

	if err := p.client.ContainerStop(ctx, containerID, stopOptions); err != nil {
		return fmt.Errorf("failed to stop container: %w", err)
	}

	return nil
}

// Remove removes a container and its resources.
func (p *Provider) Remove(ctx context.Context, sessionID string) error {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		if err == container.ErrNotFound {
			return nil // Already removed
		}
		return err
	}

	removeOptions := containerTypes.RemoveOptions{
		Force:         true,
		RemoveVolumes: true,
	}

	if err := p.client.ContainerRemove(ctx, containerID, removeOptions); err != nil {
		return fmt.Errorf("failed to remove container: %w", err)
	}

	// Remove from mapping
	p.containerIDsMu.Lock()
	delete(p.containerIDs, sessionID)
	p.containerIDsMu.Unlock()

	return nil
}

// Get returns the current state of a container.
func (p *Provider) Get(ctx context.Context, sessionID string) (*container.Container, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	info, err := p.client.ContainerInspect(ctx, containerID)
	if err != nil {
		return nil, fmt.Errorf("failed to inspect container: %w", err)
	}

	c := &container.Container{
		ID:        info.ID,
		SessionID: sessionID,
		Image:     info.Config.Image,
		Metadata: map[string]string{
			"name": info.Name,
		},
	}

	// Parse times
	if created, err := time.Parse(time.RFC3339Nano, info.Created); err == nil {
		c.CreatedAt = created
	}

	// Determine status
	switch {
	case info.State.Running:
		c.Status = container.StatusRunning
		if started, err := time.Parse(time.RFC3339Nano, info.State.StartedAt); err == nil {
			c.StartedAt = &started
		}
	case info.State.Paused:
		c.Status = container.StatusStopped
	case info.State.Dead || info.State.OOMKilled:
		c.Status = container.StatusFailed
		c.Error = info.State.Error
	case info.State.ExitCode != 0:
		c.Status = container.StatusFailed
		c.Error = fmt.Sprintf("exited with code %d", info.State.ExitCode)
	default:
		if info.State.FinishedAt != "" && info.State.FinishedAt != "0001-01-01T00:00:00Z" {
			c.Status = container.StatusStopped
			if stopped, err := time.Parse(time.RFC3339Nano, info.State.FinishedAt); err == nil {
				c.StoppedAt = &stopped
			}
		} else {
			c.Status = container.StatusCreated
		}
	}

	return c, nil
}

// Exec runs a non-interactive command in the container.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts container.ExecOptions) (*container.ExecResult, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Convert environment to slice
	var env []string
	for k, v := range opts.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	execConfig := containerTypes.ExecOptions{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
		AttachStdin:  opts.Stdin != nil,
		Env:          env,
		WorkingDir:   opts.WorkDir,
		User:         opts.User,
	}

	execCreate, err := p.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrExecFailed, err)
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrExecFailed, err)
	}
	defer resp.Close()

	// Handle stdin if provided
	if opts.Stdin != nil {
		go func() {
			io.Copy(resp.Conn, opts.Stdin)
			resp.CloseWrite()
		}()
	}

	// Read stdout and stderr
	var stdout, stderr bytes.Buffer
	_, err = stdcopy.StdCopy(&stdout, &stderr, resp.Reader)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrExecFailed, err)
	}

	// Get exit code
	inspect, err := p.client.ContainerExecInspect(ctx, execCreate.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrExecFailed, err)
	}

	return &container.ExecResult{
		ExitCode: inspect.ExitCode,
		Stdout:   stdout.Bytes(),
		Stderr:   stderr.Bytes(),
	}, nil
}

// Attach creates an interactive PTY session to the container.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts container.AttachOptions) (container.PTY, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Default to bash shell
	cmd := opts.Cmd
	if len(cmd) == 0 {
		cmd = []string{"/bin/bash"}
	}

	// Convert environment to slice
	var env []string
	for k, v := range opts.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	execConfig := containerTypes.ExecOptions{
		Cmd:          cmd,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          true,
		Env:          env,
	}

	execCreate, err := p.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrAttachFailed, err)
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{
		Tty: true,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", container.ErrAttachFailed, err)
	}

	// Resize PTY if dimensions provided
	if opts.Rows > 0 && opts.Cols > 0 {
		p.client.ContainerExecResize(ctx, execCreate.ID, containerTypes.ResizeOptions{
			Height: uint(opts.Rows),
			Width:  uint(opts.Cols),
		})
	}

	return &dockerPTY{
		client:    p.client,
		execID:    execCreate.ID,
		hijacked:  resp,
		closeOnce: sync.Once{},
	}, nil
}

// getContainerID retrieves the Docker container ID for a session.
func (p *Provider) getContainerID(ctx context.Context, sessionID string) (string, error) {
	p.containerIDsMu.RLock()
	containerID, exists := p.containerIDs[sessionID]
	p.containerIDsMu.RUnlock()

	if exists {
		return containerID, nil
	}

	// Try to find by name (for persistence across restarts)
	name := containerName(sessionID)
	info, err := p.client.ContainerInspect(ctx, name)
	if err != nil {
		return "", container.ErrNotFound
	}

	// Cache the mapping
	p.containerIDsMu.Lock()
	p.containerIDs[sessionID] = info.ID
	p.containerIDsMu.Unlock()

	return info.ID, nil
}

// Close closes the Docker client connection.
func (p *Provider) Close() error {
	return p.client.Close()
}

// dockerPTY implements container.PTY for Docker exec sessions.
type dockerPTY struct {
	client    *client.Client
	execID    string
	hijacked  types.HijackedResponse
	closeOnce sync.Once
}

func (p *dockerPTY) Read(b []byte) (int, error) {
	return p.hijacked.Reader.Read(b)
}

func (p *dockerPTY) Write(b []byte) (int, error) {
	return p.hijacked.Conn.Write(b)
}

func (p *dockerPTY) Resize(ctx context.Context, rows, cols int) error {
	return p.client.ContainerExecResize(ctx, p.execID, containerTypes.ResizeOptions{
		Height: uint(rows),
		Width:  uint(cols),
	})
}

func (p *dockerPTY) Close() error {
	p.closeOnce.Do(func() {
		p.hijacked.Close()
	})
	return nil
}

func (p *dockerPTY) Wait(ctx context.Context) (int, error) {
	// Wait for the exec to finish by polling
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-ticker.C:
			inspect, err := p.client.ContainerExecInspect(ctx, p.execID)
			if err != nil {
				return -1, err
			}
			if !inspect.Running {
				return inspect.ExitCode, nil
			}
		}
	}
}
