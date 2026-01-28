// Package docker provides a Docker-based implementation of the sandbox.Provider interface.
package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/docker/docker/api/types"
	containerTypes "github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	imageTypes "github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	volumeTypes "github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"

	"github.com/obot-platform/octobot/server/internal/config"
	"github.com/obot-platform/octobot/server/internal/sandbox"
)

const (
	// labelSecret is the label key for storing the raw shared secret.
	labelSecret = "octobot.secret"

	// containerPort is the fixed port exposed by all sandboxes.
	containerPort = 3002

	// workspacePath is where workspaces are mounted inside the container.
	workspacePath = "/.workspace"

	// dataVolumePath is where the persistent data volume is mounted inside the container.
	dataVolumePath = "/.data"

	// dataVolumePrefix is the prefix for data volume names.
	dataVolumePrefix = "octobot-data-"
)

// Provider implements the sandbox.Provider interface using Docker.
type Provider struct {
	client *client.Client
	cfg    *config.Config

	// containerIDs maps sessionID -> Docker container ID
	containerIDs   map[string]string
	containerIDsMu sync.RWMutex
}

// NewProvider creates a new Docker sandbox provider.
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
		_ = cli.Close()
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

// volumeName returns the Docker volume name for a session's data volume.
func volumeName(sessionID string) string {
	return fmt.Sprintf("%s%s", dataVolumePrefix, sessionID)
}

// ImageExists checks if the configured sandbox image is available locally.
func (p *Provider) ImageExists(ctx context.Context) bool {
	_, err := p.client.ImageInspect(ctx, p.cfg.SandboxImage)
	return err == nil
}

// Image returns the configured sandbox image name.
func (p *Provider) Image() string {
	return p.cfg.SandboxImage
}

// Create creates a new Docker container for the given session.
func (p *Provider) Create(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	// Check if sandbox already exists in cache
	p.containerIDsMu.RLock()
	cachedID, existsInCache := p.containerIDs[sessionID]
	p.containerIDsMu.RUnlock()

	name := containerName(sessionID)

	// Check if container exists by name (from previous runs)
	if existing, err := p.client.ContainerInspect(ctx, name); err == nil && existing.ContainerJSONBase != nil {
		// If we have a cached ID and it matches the existing container, return error
		if existsInCache && cachedID == existing.ID {
			return nil, sandbox.ErrAlreadyExists
		}
		// Otherwise, remove the stale container (force cleanup from previous runs)
		log.Printf("Removing stale container %s (%s) before creating new sandbox", existing.ID[:12], name)
		if err := p.client.ContainerRemove(ctx, existing.ID, containerTypes.RemoveOptions{Force: true}); err != nil {
			return nil, fmt.Errorf("failed to remove stale container: %w", err)
		}
		// Clear any stale cache entry
		p.clearContainerID(sessionID)
	} else if existsInCache {
		// Cache has an entry but container doesn't exist - clear stale cache
		p.clearContainerID(sessionID)
	}

	// Use the globally configured sandbox image
	image := p.cfg.SandboxImage

	// Ensure image is available (pull if missing)
	if err := p.ensureImage(ctx, image); err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrInvalidImage, err)
	}

	// Create data volume for persistent storage
	dataVolName := volumeName(sessionID)
	_, err := p.client.VolumeCreate(ctx, volumeTypes.CreateOptions{
		Name: dataVolName,
		Labels: map[string]string{
			"octobot.session.id": sessionID,
			"octobot.managed":    "true",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create data volume: %w", err)
	}

	// Prepare labels - store the raw secret as a label
	labels := map[string]string{
		"octobot.session.id": sessionID,
		"octobot.managed":    "true",
	}
	if opts.SharedSecret != "" {
		labels[labelSecret] = opts.SharedSecret
	}
	for k, v := range opts.Labels {
		labels[k] = v
	}

	// Build environment variables
	var env []string

	// Add session ID (required by obot-agent for AgentFS database naming)
	env = append(env, fmt.Sprintf("SESSION_ID=%s", sessionID))

	// Add hashed secret as OCTOBOT_SECRET env var
	if opts.SharedSecret != "" {
		hashedSecret := hashSecret(opts.SharedSecret)
		env = append(env, fmt.Sprintf("OCTOBOT_SECRET=%s", hashedSecret))
	}

	// Handle workspace environment variables
	// WORKSPACE_PATH is always the mount point inside the container
	// WORKSPACE_SOURCE is the original source (local path or git URL)
	if opts.WorkspacePath != "" {
		env = append(env, fmt.Sprintf("WORKSPACE_PATH=%s", workspacePath))
	}
	if opts.WorkspaceSource != "" {
		env = append(env, fmt.Sprintf("WORKSPACE_SOURCE=%s", opts.WorkspaceSource))
	}

	// Add workspace commit if provided
	if opts.WorkspaceCommit != "" {
		env = append(env, fmt.Sprintf("WORKSPACE_COMMIT=%s", opts.WorkspaceCommit))
	}

	// Container configuration
	containerConfig := &containerTypes.Config{
		Image:        image,
		Env:          env,
		Labels:       labels,
		Hostname:     "octobot",
		Tty:          true,
		OpenStdin:    true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
	}

	// Host configuration with resource limits
	hostConfig := &containerTypes.HostConfig{
		// Mount the data volume for persistent storage
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeVolume,
				Source: dataVolName,
				Target: dataVolumePath,
			},
		},
		// CAP_SYS_ADMIN is required for FUSE mounts (agentfs)
		CapAdd: []string{"SYS_ADMIN"},
		// /dev/fuse device is required for FUSE filesystems
		Resources: containerTypes.Resources{
			Devices: []containerTypes.DeviceMapping{
				{
					PathOnHost:        "/dev/fuse",
					PathInContainer:   "/dev/fuse",
					CgroupPermissions: "rwm",
				},
			},
		},
	}

	// Apply resource limits
	if opts.Resources.MemoryMB > 0 {
		hostConfig.Memory = int64(opts.Resources.MemoryMB) * 1024 * 1024
	}
	if opts.Resources.CPUCores > 0 {
		hostConfig.NanoCPUs = int64(opts.Resources.CPUCores * 1e9)
	}

	// Mount workspace directory (always a local path)
	if opts.WorkspacePath != "" {
		// Ensure the source path is absolute (Docker requires absolute paths)
		sourcePath := opts.WorkspacePath
		if !filepath.IsAbs(sourcePath) {
			absPath, err := filepath.Abs(sourcePath)
			if err != nil {
				return nil, fmt.Errorf("%w: failed to resolve absolute path for workspace: %v", sandbox.ErrStartFailed, err)
			}
			sourcePath = absPath
		}

		hostConfig.Mounts = append(hostConfig.Mounts, mount.Mount{
			Type:     mount.TypeBind,
			Source:   sourcePath,
			Target:   workspacePath,
			ReadOnly: true, // Read-only for the origin
		})
	}

	// Configure network
	if p.cfg.DockerNetwork != "" {
		hostConfig.NetworkMode = containerTypes.NetworkMode(p.cfg.DockerNetwork)
	}

	// Enable privileged mode for running Docker daemon inside container
	// The container runs its own Docker daemon (started by obot-agent if dockerd is available)
	hostConfig.Privileged = true

	// Always expose port 3002 with a random host port
	port := nat.Port(fmt.Sprintf("%d/tcp", containerPort))
	containerConfig.ExposedPorts = nat.PortSet{port: struct{}{}}
	hostConfig.PortBindings = nat.PortMap{
		port: []nat.PortBinding{{
			HostIP:   "0.0.0.0",
			HostPort: "", // Empty = Docker assigns random available port
		}},
	}

	// Create container
	resp, err := p.client.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, name)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrStartFailed, err)
	}

	// Store mapping
	p.containerIDsMu.Lock()
	p.containerIDs[sessionID] = resp.ID
	p.containerIDsMu.Unlock()

	now := time.Now()
	return &sandbox.Sandbox{
		ID:        resp.ID,
		SessionID: sessionID,
		Status:    sandbox.StatusCreated,
		Image:     image,
		CreatedAt: now,
		Metadata: map[string]string{
			"name": name,
		},
	}, nil
}

// hashSecret creates a salted SHA-256 hash of the secret.
// Returns the format "salt:hash" where both are hex-encoded.
// The salt is 16 random bytes, making each hash unique even for identical secrets.
func hashSecret(secret string) string {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		// Fall back to a zero salt if random fails (shouldn't happen)
		salt = make([]byte, 16)
	}
	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(secret))
	return hex.EncodeToString(salt) + ":" + hex.EncodeToString(h.Sum(nil))
}

// VerifySecret checks if a plaintext secret matches a salted hash.
// The hashedSecret should be in "salt:hash" format as produced by hashSecret.
func VerifySecret(plaintext, hashedSecret string) bool {
	parts := strings.SplitN(hashedSecret, ":", 2)
	if len(parts) != 2 {
		return false
	}

	salt, err := hex.DecodeString(parts[0])
	if err != nil {
		return false
	}

	h := sha256.New()
	h.Write(salt)
	h.Write([]byte(plaintext))
	expectedHash := hex.EncodeToString(h.Sum(nil))

	return expectedHash == parts[1]
}

// ensureImage checks if an image exists locally and pulls it if not.
func (p *Provider) ensureImage(ctx context.Context, image string) error {
	// Check if image exists locally
	_, err := p.client.ImageInspect(ctx, image)
	if err == nil {
		// Image exists locally
		return nil
	}

	// Image not found, pull it
	reader, err := p.client.ImagePull(ctx, image, imageTypes.PullOptions{})
	if err != nil {
		return fmt.Errorf("failed to pull image %s: %w", image, err)
	}
	defer func() { _ = reader.Close() }()

	// Drain the reader to complete the pull (progress is discarded)
	_, err = io.Copy(io.Discard, reader)
	if err != nil {
		return fmt.Errorf("failed to complete image pull for %s: %w", image, err)
	}

	return nil
}

// Start starts a previously created sandbox.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return err
	}

	if err := p.client.ContainerStart(ctx, containerID, containerTypes.StartOptions{}); err != nil {
		return fmt.Errorf("%w: %v", sandbox.ErrStartFailed, err)
	}

	return nil
}

// Stop stops a running sandbox gracefully.
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
		return fmt.Errorf("failed to stop sandbox: %w", err)
	}

	return nil
}

// Remove removes a sandbox container and optionally its associated data volume.
// By default, data volumes are preserved (useful for rebuilds).
// Pass sandbox.RemoveVolumes() to delete volumes (for session deletion).
func (p *Provider) Remove(ctx context.Context, sessionID string, opts ...sandbox.RemoveOption) error {
	cfg := sandbox.ParseRemoveOptions(opts)

	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		if err != sandbox.ErrNotFound {
			return err
		}
		// Container not found, but continue to clean up volume if requested
		containerID = ""
	}

	if containerID != "" {
		removeOptions := containerTypes.RemoveOptions{
			Force:         true,
			RemoveVolumes: true, // Only removes anonymous volumes, not named volumes
		}

		if err := p.client.ContainerRemove(ctx, containerID, removeOptions); err != nil {
			return fmt.Errorf("failed to remove sandbox container: %w", err)
		}

		// Remove from mapping
		p.containerIDsMu.Lock()
		delete(p.containerIDs, sessionID)
		p.containerIDsMu.Unlock()
	}

	// Explicitly remove the named data volume if requested
	if cfg.RemoveVolumes {
		dataVolName := volumeName(sessionID)
		if err := p.client.VolumeRemove(ctx, dataVolName, true); err != nil {
			// Don't fail if volume doesn't exist
			if !cerrdefs.IsNotFound(err) {
				return fmt.Errorf("failed to remove data volume %s: %w", dataVolName, err)
			}
		}
	}

	return nil
}

// Get returns the current state of a sandbox.
func (p *Provider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	info, err := p.client.ContainerInspect(ctx, containerID)
	if err != nil {
		// If the container was deleted externally, clear the stale cache entry
		if cerrdefs.IsNotFound(err) {
			p.clearContainerID(sessionID)
			return nil, sandbox.ErrNotFound
		}
		return nil, fmt.Errorf("failed to inspect sandbox: %w", err)
	}

	s := &sandbox.Sandbox{
		ID:        info.ID,
		SessionID: sessionID,
		Image:     info.Config.Image,
		Metadata: map[string]string{
			"name": info.Name,
		},
	}

	// Parse times
	if created, err := time.Parse(time.RFC3339Nano, info.Created); err == nil {
		s.CreatedAt = created
	}

	// Determine status
	switch {
	case info.State.Running:
		s.Status = sandbox.StatusRunning
		if started, err := time.Parse(time.RFC3339Nano, info.State.StartedAt); err == nil {
			s.StartedAt = &started
		}
	case info.State.Paused:
		s.Status = sandbox.StatusStopped
	case info.State.Dead || info.State.OOMKilled:
		s.Status = sandbox.StatusFailed
		s.Error = info.State.Error
	case info.State.ExitCode != 0:
		// Exit codes 137 (SIGKILL, 128+9) and 143 (SIGTERM, 128+15) are expected
		// from docker stop and should be treated as stopped, not failed
		if info.State.ExitCode == 137 || info.State.ExitCode == 143 {
			s.Status = sandbox.StatusStopped
			if stopped, err := time.Parse(time.RFC3339Nano, info.State.FinishedAt); err == nil {
				s.StoppedAt = &stopped
			}
		} else {
			s.Status = sandbox.StatusFailed
			s.Error = fmt.Sprintf("exited with code %d", info.State.ExitCode)
		}
	default:
		if info.State.FinishedAt != "" && info.State.FinishedAt != "0001-01-01T00:00:00Z" {
			s.Status = sandbox.StatusStopped
			if stopped, err := time.Parse(time.RFC3339Nano, info.State.FinishedAt); err == nil {
				s.StoppedAt = &stopped
			}
		} else {
			s.Status = sandbox.StatusCreated
		}
	}

	// Extract assigned port mappings
	s.Ports = p.extractPorts(info.NetworkSettings)

	// Extract environment variables
	s.Env = p.extractEnv(info.Config.Env)

	return s, nil
}

// GetSecret returns the raw shared secret stored during sandbox creation.
func (p *Provider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return "", err
	}

	info, err := p.client.ContainerInspect(ctx, containerID)
	if err != nil {
		// If the container was deleted externally, clear the stale cache entry
		if cerrdefs.IsNotFound(err) {
			p.clearContainerID(sessionID)
			return "", sandbox.ErrNotFound
		}
		return "", fmt.Errorf("failed to inspect sandbox: %w", err)
	}

	secret, ok := info.Config.Labels[labelSecret]
	if !ok || secret == "" {
		return "", fmt.Errorf("shared secret not found for sandbox")
	}

	return secret, nil
}

// extractEnv parses Docker's env slice (KEY=VALUE format) into a map.
func (p *Provider) extractEnv(envSlice []string) map[string]string {
	env := make(map[string]string)
	for _, e := range envSlice {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) == 2 {
			env[parts[0]] = parts[1]
		}
	}
	return env
}

// extractPorts extracts assigned port mappings from container network settings.
func (p *Provider) extractPorts(settings *containerTypes.NetworkSettings) []sandbox.AssignedPort {
	if settings == nil {
		return nil
	}

	var ports []sandbox.AssignedPort
	for containerPort, bindings := range settings.Ports {
		for _, binding := range bindings {
			hostPort, _ := strconv.Atoi(binding.HostPort)
			ports = append(ports, sandbox.AssignedPort{
				ContainerPort: containerPort.Int(),
				HostPort:      hostPort,
				HostIP:        binding.HostIP,
				Protocol:      containerPort.Proto(),
			})
		}
	}
	return ports
}

// Exec runs a non-interactive command in the sandbox.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Convert environment to slice
	env := make([]string, 0, len(opts.Env))
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
		return nil, fmt.Errorf("%w: %v", sandbox.ErrExecFailed, err)
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrExecFailed, err)
	}
	defer resp.Close()

	// Handle stdin if provided
	if opts.Stdin != nil {
		go func() {
			_, _ = io.Copy(resp.Conn, opts.Stdin)
			_ = resp.CloseWrite()
		}()
	}

	// Read stdout and stderr
	var stdout, stderr bytes.Buffer
	_, err = stdcopy.StdCopy(&stdout, &stderr, resp.Reader)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrExecFailed, err)
	}

	// Get exit code
	inspect, err := p.client.ContainerExecInspect(ctx, execCreate.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrExecFailed, err)
	}

	return &sandbox.ExecResult{
		ExitCode: inspect.ExitCode,
		Stdout:   stdout.Bytes(),
		Stderr:   stderr.Bytes(),
	}, nil
}

// detectShell determines the best available shell in the container.
// It tries shells in this order: $SHELL → /bin/bash → /bin/sh
func (p *Provider) detectShell(ctx context.Context, containerID string) []string {
	// Create a quick timeout context for shell detection
	detectCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	// First, try to get $SHELL from the environment
	execConfig := containerTypes.ExecOptions{
		Cmd:          []string{"sh", "-c", "echo $SHELL"},
		AttachStdout: true,
		AttachStderr: true,
	}

	execCreate, err := p.client.ContainerExecCreate(detectCtx, containerID, execConfig)
	if err == nil {
		resp, err := p.client.ContainerExecAttach(detectCtx, execCreate.ID, containerTypes.ExecStartOptions{})
		if err == nil {
			var stdout, stderr bytes.Buffer
			_, _ = stdcopy.StdCopy(&stdout, &stderr, resp.Reader)
			resp.Close()

			shell := strings.TrimSpace(stdout.String())
			if shell != "" && shell != "$SHELL" {
				// Verify the shell exists
				if p.shellExists(detectCtx, containerID, shell) {
					return []string{shell}
				}
			}
		}
	}

	// Try /bin/bash
	if p.shellExists(detectCtx, containerID, "/bin/bash") {
		return []string{"/bin/bash"}
	}

	// Fall back to /bin/sh (should always exist)
	return []string{"/bin/sh"}
}

// shellExists checks if a shell binary exists and is executable in the container.
func (p *Provider) shellExists(ctx context.Context, containerID string, shell string) bool {
	execConfig := containerTypes.ExecOptions{
		Cmd:          []string{"test", "-x", shell},
		AttachStdout: true,
		AttachStderr: true,
	}

	execCreate, err := p.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return false
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{})
	if err != nil {
		return false
	}
	defer resp.Close()

	// Drain output
	_, _ = io.Copy(io.Discard, resp.Reader)

	// Check exit code
	inspect, err := p.client.ContainerExecInspect(ctx, execCreate.ID)
	if err != nil {
		return false
	}

	return inspect.ExitCode == 0
}

// Attach creates an interactive PTY session to the sandbox.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Determine shell to use
	cmd := opts.Cmd
	if len(cmd) == 0 {
		cmd = p.detectShell(ctx, containerID)
	}

	// Convert environment to slice
	env := make([]string, 0, len(opts.Env))
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
		User:         opts.User,
	}

	execCreate, err := p.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrAttachFailed, err)
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{
		Tty: true,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", sandbox.ErrAttachFailed, err)
	}

	// Resize PTY if dimensions provided
	if opts.Rows > 0 && opts.Cols > 0 {
		_ = p.client.ContainerExecResize(ctx, execCreate.ID, containerTypes.ResizeOptions{
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

// ExecStream runs a command with bidirectional streaming I/O (no TTY).
func (p *Provider) ExecStream(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	containerID, err := p.getContainerID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Convert environment to slice
	env := make([]string, 0, len(opts.Env))
	for k, v := range opts.Env {
		env = append(env, fmt.Sprintf("%s=%s", k, v))
	}

	execConfig := containerTypes.ExecOptions{
		Cmd:          cmd,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          false, // No TTY for binary-safe streaming
		Env:          env,
		User:         opts.User,
		WorkingDir:   opts.WorkDir,
	}

	execCreate, err := p.client.ContainerExecCreate(ctx, containerID, execConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create exec: %w", err)
	}

	resp, err := p.client.ContainerExecAttach(ctx, execCreate.ID, containerTypes.ExecStartOptions{
		Tty: false,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to attach exec: %w", err)
	}

	// Create pipes for demultiplexed stdout and stderr
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()

	// Start goroutine to demultiplex Docker's multiplexed stream
	go func() {
		defer stdoutWriter.Close()
		defer stderrWriter.Close()
		// stdcopy.StdCopy reads the multiplexed stream and writes to separate writers
		_, _ = stdcopy.StdCopy(stdoutWriter, stderrWriter, resp.Reader)
	}()

	return &dockerStream{
		client:       p.client,
		execID:       execCreate.ID,
		hijacked:     resp,
		stdoutReader: stdoutReader,
		stderrReader: stderrReader,
		closeOnce:    sync.Once{},
	}, nil
}

// List returns all sandboxes managed by octobot.
func (p *Provider) List(ctx context.Context) ([]*sandbox.Sandbox, error) {
	// List all containers with our label
	containers, err := p.client.ContainerList(ctx, containerTypes.ListOptions{
		All: true, // Include stopped containers
		Filters: filters.NewArgs(
			filters.Arg("label", "octobot.managed=true"),
		),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list sandboxes: %w", err)
	}

	result := make([]*sandbox.Sandbox, 0, len(containers))
	for _, c := range containers {
		// Extract session ID from labels
		sessionID := c.Labels["octobot.session.id"]
		if sessionID == "" {
			continue
		}

		// Get full container info
		info, err := p.client.ContainerInspect(ctx, c.ID)
		if err != nil {
			continue // Skip containers we can't inspect
		}

		sb := &sandbox.Sandbox{
			ID:        info.ID,
			SessionID: sessionID,
			Image:     info.Config.Image,
			Metadata: map[string]string{
				"name": info.Name,
			},
		}

		// Parse times
		if created, err := time.Parse(time.RFC3339Nano, info.Created); err == nil {
			sb.CreatedAt = created
		}

		// Determine status
		switch {
		case info.State.Running:
			sb.Status = sandbox.StatusRunning
			if started, err := time.Parse(time.RFC3339Nano, info.State.StartedAt); err == nil {
				sb.StartedAt = &started
			}
		case info.State.Paused:
			sb.Status = sandbox.StatusStopped
		case info.State.Dead || info.State.OOMKilled:
			sb.Status = sandbox.StatusFailed
			sb.Error = info.State.Error
		case info.State.ExitCode != 0:
			// Exit codes 137 (SIGKILL, 128+9) and 143 (SIGTERM, 128+15) are expected
			// from docker stop and should be treated as stopped, not failed
			if info.State.ExitCode == 137 || info.State.ExitCode == 143 {
				sb.Status = sandbox.StatusStopped
				if stopped, err := time.Parse(time.RFC3339Nano, info.State.FinishedAt); err == nil {
					sb.StoppedAt = &stopped
				}
			} else {
				sb.Status = sandbox.StatusFailed
				sb.Error = fmt.Sprintf("exited with code %d", info.State.ExitCode)
			}
		default:
			if info.State.FinishedAt != "" && info.State.FinishedAt != "0001-01-01T00:00:00Z" {
				sb.Status = sandbox.StatusStopped
				if stopped, err := time.Parse(time.RFC3339Nano, info.State.FinishedAt); err == nil {
					sb.StoppedAt = &stopped
				}
			} else {
				sb.Status = sandbox.StatusCreated
			}
		}

		// Extract assigned port mappings
		sb.Ports = p.extractPorts(info.NetworkSettings)

		// Extract environment variables
		sb.Env = p.extractEnv(info.Config.Env)

		// Cache the mapping
		p.containerIDsMu.Lock()
		p.containerIDs[sessionID] = info.ID
		p.containerIDsMu.Unlock()

		result = append(result, sb)
	}

	return result, nil
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
		return "", sandbox.ErrNotFound
	}

	// Cache the mapping
	p.containerIDsMu.Lock()
	p.containerIDs[sessionID] = info.ID
	p.containerIDsMu.Unlock()

	return info.ID, nil
}

// clearContainerID removes a container ID from the cache.
// This is used when a container is deleted externally.
func (p *Provider) clearContainerID(sessionID string) {
	p.containerIDsMu.Lock()
	delete(p.containerIDs, sessionID)
	p.containerIDsMu.Unlock()
}

// Close closes the Docker client connection.
func (p *Provider) Close() error {
	return p.client.Close()
}

// dockerPTY implements sandbox.PTY for Docker exec sessions.
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

// dockerStream implements sandbox.Stream for Docker exec sessions without TTY.
type dockerStream struct {
	client       *client.Client
	execID       string
	hijacked     types.HijackedResponse
	stdoutReader *io.PipeReader
	stderrReader *io.PipeReader
	closeOnce    sync.Once
}

func (s *dockerStream) Read(b []byte) (int, error) {
	return s.stdoutReader.Read(b)
}

func (s *dockerStream) Stderr() io.Reader {
	return s.stderrReader
}

func (s *dockerStream) Write(b []byte) (int, error) {
	return s.hijacked.Conn.Write(b)
}

func (s *dockerStream) CloseWrite() error {
	// Close the write side of the connection
	if cw, ok := s.hijacked.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return nil
}

func (s *dockerStream) Close() error {
	s.closeOnce.Do(func() {
		s.hijacked.Close()
	})
	return nil
}

func (s *dockerStream) Wait(ctx context.Context) (int, error) {
	// Wait for the exec to finish by polling
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return -1, ctx.Err()
		case <-ticker.C:
			inspect, err := s.client.ContainerExecInspect(ctx, s.execID)
			if err != nil {
				return -1, err
			}
			if !inspect.Running {
				return inspect.ExitCode, nil
			}
		}
	}
}

// HTTPClient returns an HTTP client configured to communicate with the sandbox.
// For Docker, this creates a client that connects to the mapped TCP port.
func (p *Provider) HTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	sb, err := p.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	if sb.Status != sandbox.StatusRunning {
		return nil, fmt.Errorf("sandbox is not running: %s", sb.Status)
	}

	// Find the HTTP port (3002)
	var httpPort *sandbox.AssignedPort
	for i := range sb.Ports {
		if sb.Ports[i].ContainerPort == containerPort {
			httpPort = &sb.Ports[i]
			break
		}
	}
	if httpPort == nil {
		return nil, fmt.Errorf("sandbox does not expose port %d", containerPort)
	}

	hostIP := httpPort.HostIP
	if hostIP == "" || hostIP == "0.0.0.0" {
		hostIP = "127.0.0.1"
	}

	// Create a custom transport that always dials to the sandbox's mapped port
	baseURL := fmt.Sprintf("%s:%d", hostIP, httpPort.HostPort)
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			// Always connect to the sandbox's mapped port, ignoring the addr from the URL
			var d net.Dialer
			return d.DialContext(ctx, "tcp", baseURL)
		},
	}

	return &http.Client{Transport: transport}, nil
}

// Watch returns a channel that receives sandbox state change events.
// It first replays the current state of all existing sandboxes, then streams
// state changes as they occur by watching Docker events.
func (p *Provider) Watch(ctx context.Context) (<-chan sandbox.StateEvent, error) {
	eventCh := make(chan sandbox.StateEvent, 100)

	// Start a goroutine to handle the watch
	go func() {
		defer close(eventCh)

		// First, replay current state of all managed sandboxes
		sandboxes, err := p.List(ctx)
		if err != nil {
			log.Printf("Watch: failed to list sandboxes for replay: %v", err)
			// Continue anyway - we can still watch for new events
		} else {
			for _, sb := range sandboxes {
				select {
				case <-ctx.Done():
					return
				case eventCh <- sandbox.StateEvent{
					SessionID: sb.SessionID,
					Status:    sb.Status,
					Timestamp: time.Now(),
					Error:     sb.Error,
				}:
				}
			}
		}

		// Set up Docker events filter for our managed containers
		filterArgs := filters.NewArgs(
			filters.Arg("type", string(events.ContainerEventType)),
			filters.Arg("label", "octobot.managed=true"),
		)

		// Watch Docker events
		p.watchDockerEvents(ctx, eventCh, filterArgs)
	}()

	return eventCh, nil
}

// watchDockerEvents watches Docker container events and translates them to sandbox events.
// It automatically reconnects if the connection is lost.
func (p *Provider) watchDockerEvents(ctx context.Context, eventCh chan<- sandbox.StateEvent, filterArgs filters.Args) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Start watching Docker events
		msgCh, errCh := p.client.Events(ctx, events.ListOptions{
			Filters: filterArgs,
		})

		// Process events until error or context cancellation
		if !p.processDockerEvents(ctx, eventCh, msgCh, errCh) {
			return // Context cancelled or unrecoverable error
		}

		// If we get here, there was a recoverable error - wait before reconnecting
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
			log.Printf("Watch: reconnecting to Docker events...")
		}
	}
}

// processDockerEvents processes Docker events from the channels.
// Returns false if the context was cancelled (caller should exit),
// returns true if reconnection should be attempted.
func (p *Provider) processDockerEvents(ctx context.Context, eventCh chan<- sandbox.StateEvent, msgCh <-chan events.Message, errCh <-chan error) bool {
	for {
		select {
		case <-ctx.Done():
			return false

		case err := <-errCh:
			if err == nil {
				// Channel closed, reconnect
				return true
			}
			if ctx.Err() != nil {
				return false
			}
			log.Printf("Watch: Docker events error: %v, reconnecting...", err)
			return true

		case msg := <-msgCh:
			event := p.translateDockerEvent(msg)
			if event != nil {
				select {
				case <-ctx.Done():
					return false
				case eventCh <- *event:
				}
			}
		}
	}
}

// translateDockerEvent converts a Docker event to a sandbox StateEvent.
// Returns nil if the event should be ignored.
func (p *Provider) translateDockerEvent(msg events.Message) *sandbox.StateEvent {
	// Extract session ID from container labels
	sessionID := msg.Actor.Attributes["octobot.session.id"]
	if sessionID == "" {
		// Not one of our containers or missing session ID
		return nil
	}

	var status sandbox.Status
	var errMsg string

	switch msg.Action {
	case "create":
		status = sandbox.StatusCreated
	case "start":
		status = sandbox.StatusRunning
	case "stop", "kill":
		status = sandbox.StatusStopped
	case "die":
		// Check exit code to determine if stopped or failed
		exitCode := msg.Actor.Attributes["exitCode"]
		if exitCode == "137" || exitCode == "143" || exitCode == "0" {
			// Normal stop (SIGKILL, SIGTERM, or clean exit)
			status = sandbox.StatusStopped
		} else {
			status = sandbox.StatusFailed
			errMsg = fmt.Sprintf("container died with exit code %s", exitCode)
		}
	case "destroy":
		status = sandbox.StatusRemoved
		// Clear container ID from cache since it's been deleted
		p.clearContainerID(sessionID)
	case "oom":
		status = sandbox.StatusFailed
		errMsg = "out of memory"
	default:
		// Ignore other events (pause, unpause, attach, etc.)
		return nil
	}

	return &sandbox.StateEvent{
		SessionID: sessionID,
		Status:    status,
		Timestamp: time.Unix(msg.Time, msg.TimeNano),
		Error:     errMsg,
	}
}
