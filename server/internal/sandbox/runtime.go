// Package sandbox provides an abstraction for sandbox execution environments.
// It supports multiple backends including Docker, Kubernetes, and Cloudflare sandboxes.
package sandbox

import (
	"context"
	"io"
	"net/http"
	"time"
)

// Provider abstracts sandbox execution environments (Docker, K8s, Cloudflare, etc.)
// Each session gets one dedicated sandbox, managed through this interface.
type Provider interface {
	// ImageExists checks if the configured sandbox image is available locally.
	// Returns true if the image exists, false if it needs to be pulled.
	ImageExists(ctx context.Context) bool

	// Image returns the configured sandbox image name.
	Image() string

	// Create creates a new sandbox for the given session.
	// The sandbox is created but not started.
	// A single port (3002) is always exposed and assigned a random host port.
	// If the image doesn't exist locally, it will be pulled automatically.
	Create(ctx context.Context, sessionID string, opts CreateOptions) (*Sandbox, error)

	// Start starts a previously created sandbox.
	Start(ctx context.Context, sessionID string) error

	// Stop stops a running sandbox gracefully.
	// The timeout specifies how long to wait before force-killing.
	Stop(ctx context.Context, sessionID string, timeout time.Duration) error

	// Remove removes a sandbox and its resources.
	// The sandbox must be stopped first.
	Remove(ctx context.Context, sessionID string) error

	// Get returns the current state of a sandbox.
	Get(ctx context.Context, sessionID string) (*Sandbox, error)

	// GetSecret returns the shared secret for the sandbox.
	// This is the raw secret stored during creation, not the hashed version.
	GetSecret(ctx context.Context, sessionID string) (string, error)

	// List returns all sandboxes managed by octobot.
	// This includes sandboxes in any state (running, stopped, failed).
	List(ctx context.Context) ([]*Sandbox, error)

	// Exec runs a non-interactive command in the sandbox.
	// Returns stdout, stderr, and exit code.
	Exec(ctx context.Context, sessionID string, cmd []string, opts ExecOptions) (*ExecResult, error)

	// Attach creates an interactive PTY session to the sandbox.
	// The PTY can be used for bidirectional terminal communication.
	Attach(ctx context.Context, sessionID string, opts AttachOptions) (PTY, error)

	// HTTPClient returns an HTTP client configured to communicate with the sandbox.
	// The client handles the transport layer (TCP for Docker, vsock for vz, etc.).
	// The returned client connects to the sandbox's HTTP server (port 3002).
	HTTPClient(ctx context.Context, sessionID string) (*http.Client, error)
}

// Sandbox represents a running or stopped sandbox instance.
type Sandbox struct {
	ID        string            // Runtime-specific sandbox ID
	SessionID string            // Octobot session ID (1:1 mapping)
	Status    SandboxStatus     // created, running, stopped, failed
	Image     string            // Sandbox image used
	CreatedAt time.Time         // When the sandbox was created
	StartedAt *time.Time        // When the sandbox was started (nil if never started)
	StoppedAt *time.Time        // When the sandbox was stopped (nil if still running)
	Error     string            // Error message if status == failed
	Metadata  map[string]string // Runtime-specific metadata
	Ports     []AssignedPort    // Assigned port mappings after sandbox creation
	Env       map[string]string // Environment variables set on the sandbox
}

// AssignedPort represents a port mapping that was assigned after sandbox creation.
type AssignedPort struct {
	ContainerPort int    // Port inside the sandbox
	HostPort      int    // Actual port assigned on the host
	HostIP        string // Host IP address (typically "0.0.0.0" or "127.0.0.1")
	Protocol      string // Protocol: "tcp" or "udp"
}

// SandboxStatus represents the current state of a sandbox.
type SandboxStatus string

const (
	StatusCreated SandboxStatus = "created" // Sandbox exists but not started
	StatusRunning SandboxStatus = "running" // Sandbox is running
	StatusStopped SandboxStatus = "stopped" // Sandbox has stopped
	StatusFailed  SandboxStatus = "failed"  // Sandbox failed to start or crashed
)

// CreateOptions configures sandbox creation.
// Note: The sandbox image is configured globally via SANDBOX_IMAGE env var,
// not per-sandbox. The provider uses its configured image for all sandboxes.
type CreateOptions struct {
	Labels map[string]string // Sandbox labels/tags for identification

	// SharedSecret is the secret used for authenticating requests to the sandbox.
	// The provider stores this secret and makes a salted+hashed version available
	// to the sandbox via the OCTOBOT_SECRET environment variable.
	SharedSecret string

	// WorkspacePath is either a local directory path or a git URL.
	// For Docker: if it's a directory, it will be bind-mounted to /.workspace.origin
	// and WORKSPACE_PATH env var will be set to /.workspace.origin.
	// If it's a git URL, WORKSPACE_PATH will be set to the URL.
	WorkspacePath string

	// WorkspaceCommit is the git commit to checkout (optional).
	// Set as WORKSPACE_COMMIT environment variable.
	WorkspaceCommit string

	// Resources defines resource limits for the sandbox.
	Resources ResourceConfig
}

// ResourceConfig defines resource limits for the sandbox.
type ResourceConfig struct {
	MemoryMB int           // Memory limit in MB (0 = no limit)
	CPUCores float64       // CPU cores (0 = no limit)
	DiskMB   int           // Disk space in MB (0 = no limit)
	Timeout  time.Duration // Max sandbox lifetime (0 = no limit)
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

// PTY represents an interactive terminal session to a sandbox.
// It implements io.ReadWriteCloser for terminal I/O.
type PTY interface {
	// Read reads output from the PTY.
	// Implements io.Reader.
	Read(p []byte) (n int, err error)

	// Write sends input to the PTY.
	// Implements io.Writer.
	Write(p []byte) (n int, err error)

	// Resize changes the terminal dimensions.
	Resize(ctx context.Context, rows, cols int) error

	// Close terminates the PTY session.
	// Implements io.Closer.
	Close() error

	// Wait blocks until the PTY command exits and returns the exit code.
	// The context can be used to cancel the wait.
	Wait(ctx context.Context) (int, error)
}
