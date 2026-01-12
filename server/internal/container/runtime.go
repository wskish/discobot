// Package container provides an abstraction for container execution environments.
// It supports multiple backends including Docker, Kubernetes, and Cloudflare sandboxes.
package container

import (
	"context"
	"io"
	"time"
)

// Runtime abstracts container execution environments (Docker, K8s, Cloudflare, etc.)
// Each session gets one dedicated container, managed through this interface.
type Runtime interface {
	// Create creates a new container for the given session.
	// The container is created but not started.
	Create(ctx context.Context, sessionID string, opts CreateOptions) (*Container, error)

	// Start starts a previously created container.
	Start(ctx context.Context, sessionID string) error

	// Stop stops a running container gracefully.
	// The timeout specifies how long to wait before force-killing.
	Stop(ctx context.Context, sessionID string, timeout time.Duration) error

	// Remove removes a container and its resources.
	// The container must be stopped first.
	Remove(ctx context.Context, sessionID string) error

	// Get returns the current state of a container.
	Get(ctx context.Context, sessionID string) (*Container, error)

	// Exec runs a non-interactive command in the container.
	// Returns stdout, stderr, and exit code.
	Exec(ctx context.Context, sessionID string, cmd []string, opts ExecOptions) (*ExecResult, error)

	// Attach creates an interactive PTY session to the container.
	// The PTY can be used for bidirectional terminal communication.
	Attach(ctx context.Context, sessionID string, opts AttachOptions) (PTY, error)
}

// Container represents a running or stopped container instance.
type Container struct {
	ID        string            // Runtime-specific container ID
	SessionID string            // Octobot session ID (1:1 mapping)
	Status    ContainerStatus   // created, running, stopped, failed
	Image     string            // Container image used
	CreatedAt time.Time         // When the container was created
	StartedAt *time.Time        // When the container was started (nil if never started)
	StoppedAt *time.Time        // When the container was stopped (nil if still running)
	Error     string            // Error message if status == failed
	Metadata  map[string]string // Runtime-specific metadata
}

// ContainerStatus represents the current state of a container.
type ContainerStatus string

const (
	StatusCreated ContainerStatus = "created" // Container exists but not started
	StatusRunning ContainerStatus = "running" // Container is running
	StatusStopped ContainerStatus = "stopped" // Container has stopped
	StatusFailed  ContainerStatus = "failed"  // Container failed to start or crashed
)

// CreateOptions configures container creation.
type CreateOptions struct {
	Image   string            // Container image (e.g., "ubuntu:22.04")
	WorkDir string            // Working directory inside container
	Env     map[string]string // Environment variables
	Labels  map[string]string // Container labels/tags for identification

	// Storage configures how workspace files are made available.
	// Interpretation is runtime-specific (Docker mounts, K8s PVCs, etc.)
	Storage StorageConfig

	// Resources defines resource limits for the container.
	Resources ResourceConfig
}

// StorageConfig defines how workspace files are made available to the container.
// The actual implementation varies by runtime:
// - Docker: bind mounts
// - Kubernetes: PersistentVolumeClaims
// - Cloudflare: R2/KV storage
type StorageConfig struct {
	WorkspacePath string // Host/source path to workspace
	MountPath     string // Path inside container where workspace appears
	ReadOnly      bool   // Whether mount is read-only
}

// ResourceConfig defines resource limits for the container.
type ResourceConfig struct {
	MemoryMB int           // Memory limit in MB (0 = no limit)
	CPUCores float64       // CPU cores (0 = no limit)
	DiskMB   int           // Disk space in MB (0 = no limit)
	Timeout  time.Duration // Max container lifetime (0 = no limit)
}

// ExecOptions configures non-interactive command execution.
type ExecOptions struct {
	WorkDir string            // Working directory for command
	Env     map[string]string // Additional environment variables
	User    string            // User to run as (empty = default)
	Stdin   io.Reader         // Optional stdin input
}

// ExecResult contains the result of a non-interactive command execution.
type ExecResult struct {
	ExitCode int    // Exit code of the command
	Stdout   []byte // Standard output
	Stderr   []byte // Standard error
}

// AttachOptions configures interactive PTY session creation.
type AttachOptions struct {
	Cmd  []string          // Command to run (empty = default shell)
	Rows int               // Terminal rows
	Cols int               // Terminal columns
	Env  map[string]string // Additional environment variables
}

// PTY represents an interactive terminal session to a container.
// It implements io.ReadWriteCloser for terminal I/O.
type PTY interface {
	// Read reads output from the PTY.
	// Implements io.Reader.
	Read(p []byte) (n int, err error)

	// Write sends input to the PTY.
	// Implements io.Writer.
	Write(p []byte) (n int, err error)

	// Resize changes the terminal dimensions.
	Resize(rows, cols int) error

	// Close terminates the PTY session.
	// Implements io.Closer.
	Close() error

	// Wait blocks until the PTY command exits and returns the exit code.
	Wait() (int, error)
}
