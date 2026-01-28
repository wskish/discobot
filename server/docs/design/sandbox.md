# Sandbox Module

This module provides the sandbox runtime abstraction for managing Docker containers.

## Files

| File | Description |
|------|-------------|
| `internal/sandbox/runtime.go` | Provider interface definition |
| `internal/sandbox/errors.go` | Error types |
| `internal/sandbox/docker/provider.go` | Docker implementation |
| `internal/sandbox/mock/provider.go` | Mock implementation for testing |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sandbox Abstraction                          │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Provider Interface                      │  │
│  │  Create, Start, Stop, Remove, Get, List, Exec, Attach    │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│          ┌────────────────┴────────────────┐                    │
│          ▼                                 ▼                    │
│  ┌─────────────────┐               ┌─────────────────┐         │
│  │     Docker      │               │      Mock       │         │
│  │    Provider     │               │    Provider     │         │
│  └─────────────────┘               └─────────────────┘         │
│          │                                 │                    │
│          ▼                                 ▼                    │
│     Docker API                      In-Memory State            │
└─────────────────────────────────────────────────────────────────┘
```

## Provider Interface

```go
type Provider interface {
    // Create a new sandbox
    Create(ctx context.Context, sessionID string, opts Options) (*Sandbox, error)

    // Start a sandbox
    Start(ctx context.Context, sessionID string) error

    // Stop a sandbox
    Stop(ctx context.Context, sessionID string, timeout time.Duration) error

    // Remove a sandbox and optionally its data volumes
    // Pass sandbox.RemoveVolumes() to delete volumes
    Remove(ctx context.Context, sessionID string, opts ...RemoveOption) error

    // Get sandbox info
    Get(ctx context.Context, sessionID string) (*Sandbox, error)

    // List all sandboxes
    List(ctx context.Context) ([]*Sandbox, error)

    // Execute command in sandbox
    Exec(ctx context.Context, sessionID string, cmd []string, opts ExecOptions) (*ExecResult, error)

    // Attach to sandbox (PTY)
    Attach(ctx context.Context, sessionID string, opts AttachOptions) (PTY, error)
}
```

## Types

### Sandbox

```go
type Sandbox struct {
    ID        string            // Docker container ID
    SessionID string            // Octobot session ID
    Status    string            // created, running, stopped
    Address   string            // HTTP address (host:port)
    Labels    map[string]string
    CreatedAt time.Time
}
```

### Options

```go
type Options struct {
    Image       string            // Container image
    Cmd         []string          // Command to run
    Env         []string          // Environment variables
    Binds       []string          // Volume mounts
    NetworkMode string            // Docker network
    Labels      map[string]string // Container labels
    PortBindings map[string]string // Port mappings
}
```

### ExecOptions

```go
type ExecOptions struct {
    Env        []string // Additional environment
    WorkingDir string   // Working directory
    Tty        bool     // Allocate TTY
}
```

### AttachOptions

```go
type AttachOptions struct {
    Cmd  []string // Command to run (empty = auto-detect shell)
    Rows int      // Terminal rows
    Cols int      // Terminal columns
    Env  map[string]string // Environment variables
    User string   // User to run as (empty = sandbox default, "root" = root, or "UID:GID")
}
```

### ExecResult

```go
type ExecResult struct {
    ExitCode int
    Stdout   string
    Stderr   string
}
```

### PTY Interface

```go
type PTY interface {
    io.ReadWriteCloser
    Resize(height, width uint) error
}
```

## Docker Provider

### Implementation

```go
type Provider struct {
    client *client.Client
    config *config.Config
}

func NewProvider(cfg *config.Config) (*Provider, error) {
    cli, err := client.NewClientWithOpts(
        client.FromEnv,
        client.WithAPIVersionNegotiation(),
    )
    if err != nil {
        return nil, err
    }

    return &Provider{
        client: cli,
        config: cfg,
    }, nil
}
```

### Sandbox Naming

```go
func (p *Provider) sandboxName(sessionID string) string {
    return fmt.Sprintf("octobot-session-%s", sessionID)
}
```

### Create

```go
func (p *Provider) Create(
    ctx context.Context,
    sessionID string,
    opts Options,
) (*Sandbox, error) {
    name := p.sandboxName(sessionID)

    // Container config
    containerConfig := &dockercontainer.Config{
        Image: opts.Image,
        Cmd:   opts.Cmd,
        Env:   opts.Env,
        Labels: map[string]string{
            "octobot.session": sessionID,
        },
        ExposedPorts: nat.PortSet{
            "3002/tcp": struct{}{},
        },
    }

    // Host config
    hostConfig := &dockercontainer.HostConfig{
        Binds:       opts.Binds,
        NetworkMode: dockercontainer.NetworkMode(opts.NetworkMode),
        PortBindings: nat.PortMap{
            "3002/tcp": []nat.PortBinding{
                {HostIP: "127.0.0.1", HostPort: "0"}, // Random port
            },
        },
    }

    // Create container
    resp, err := p.client.ContainerCreate(
        ctx,
        containerConfig,
        hostConfig,
        nil, nil,
        name,
    )
    if err != nil {
        return nil, err
    }

    return &Sandbox{
        ID:        resp.ID,
        SessionID: sessionID,
        Status:    "created",
    }, nil
}
```

### Start

```go
func (p *Provider) Start(ctx context.Context, sessionID string) error {
    name := p.sandboxName(sessionID)
    return p.client.ContainerStart(ctx, name, dockercontainer.StartOptions{})
}
```

### Get with Address

```go
func (p *Provider) Get(ctx context.Context, sessionID string) (*Sandbox, error) {
    name := p.sandboxName(sessionID)

    info, err := p.client.ContainerInspect(ctx, name)
    if err != nil {
        return nil, err
    }

    // Get assigned port
    bindings := info.NetworkSettings.Ports["3002/tcp"]
    address := ""
    if len(bindings) > 0 {
        address = fmt.Sprintf("http://127.0.0.1:%s", bindings[0].HostPort)
    }

    return &Sandbox{
        ID:        info.ID,
        SessionID: sessionID,
        Status:    info.State.Status,
        Address:   address,
        CreatedAt: info.Created,
    }, nil
}
```

### Attach (PTY)

Creates an interactive PTY session with automatic shell detection:

```go
func (p *Provider) Attach(
    ctx context.Context,
    sessionID string,
    opts AttachOptions,
) (PTY, error) {
    name := p.sandboxName(sessionID)

    // Detect shell if not specified
    cmd := opts.Cmd
    if len(cmd) == 0 {
        cmd = p.detectShell(ctx, name)
    }

    // Create exec with PTY
    execConfig := container.ExecOptions{
        Cmd:          cmd,
        User:         opts.User,  // "root", "UID:GID", or empty for default
        Tty:          true,
        AttachStdin:  true,
        AttachStdout: true,
        AttachStderr: true,
    }
    // ... create exec and attach
}
```

#### Shell Detection

When no command is specified, the provider detects the appropriate shell:

```go
func (p *Provider) detectShell(ctx context.Context, containerID string) []string {
    // 1. Try $SHELL environment variable
    result, err := p.execSimple(ctx, containerID, []string{"sh", "-c", "echo $SHELL"})
    if err == nil && result != "" && result != "/bin/false" {
        return []string{result}
    }

    // 2. Try /bin/bash
    if p.commandExists(ctx, containerID, "/bin/bash") {
        return []string{"/bin/bash"}
    }

    // 3. Fall back to /bin/sh
    return []string{"/bin/sh"}
}
```

This ensures the terminal uses the user's preferred shell when available.

### Exec

```go
func (p *Provider) Exec(
    ctx context.Context,
    sessionID string,
    cmd []string,
    opts ExecOptions,
) (*ExecResult, error) {
    name := p.sandboxName(sessionID)

    execConfig := container.ExecOptions{
        Cmd:          cmd,
        AttachStdout: true,
        AttachStderr: true,
        Env:          opts.Env,
        WorkingDir:   opts.WorkingDir,
    }

    execID, err := p.client.ContainerExecCreate(ctx, name, execConfig)
    if err != nil {
        return nil, err
    }

    resp, err := p.client.ContainerExecAttach(ctx, execID.ID, container.ExecStartOptions{})
    if err != nil {
        return nil, err
    }
    defer resp.Close()

    // Read output
    var stdout, stderr bytes.Buffer
    _, _ = stdcopy.StdCopy(&stdout, &stderr, resp.Reader)

    // Get exit code
    inspect, _ := p.client.ContainerExecInspect(ctx, execID.ID)

    return &ExecResult{
        ExitCode: inspect.ExitCode,
        Stdout:   stdout.String(),
        Stderr:   stderr.String(),
    }, nil
}
```

## Mock Provider

### Implementation

```go
type MockProvider struct {
    sandboxes map[string]*Sandbox
    mu        sync.RWMutex
}

func NewMockProvider() *MockProvider {
    return &MockProvider{
        sandboxes: make(map[string]*Sandbox),
    }
}

func (m *MockProvider) Create(
    ctx context.Context,
    sessionID string,
    opts Options,
) (*Sandbox, error) {
    m.mu.Lock()
    defer m.mu.Unlock()

    s := &Sandbox{
        ID:        uuid.New().String(),
        SessionID: sessionID,
        Status:    "created",
        Address:   "http://mock:3002",
        CreatedAt: time.Now(),
    }

    m.sandboxes[sessionID] = s
    return s, nil
}
```

## Error Types

```go
var (
    ErrNotFound = errors.New("sandbox not found")
    ErrStopped  = errors.New("sandbox is stopped")
    ErrExecFailed = errors.New("exec failed")
)
```

## Sandbox Labels

Labels are used to identify Octobot sandboxes:

```go
labels := map[string]string{
    "octobot":         "true",
    "octobot.session": sessionID,
    "octobot.project": projectID,
}
```

## Container Removal with Optional Volume Cleanup

The sandbox provider's `Remove()` method accepts optional `RemoveOption` parameters:

### Default behavior (no options)
- **Purpose**: Remove container for rebuild scenarios (e.g., image updates)
- **Behavior**: Deletes the container but preserves data volumes
- **Use case**: Image reconciliation, container recreation, failed container recovery
- **Docker**: Removes container only, leaves `octobot-data-{sessionID}` volume intact
- **VZ**: Removes VM (always removes disk)

```go
// Used during sandbox reconciliation to rebuild outdated containers
// No options = preserves volumes by default
if err := provider.Remove(ctx, sessionID); err != nil {
    return err
}
```

### With sandbox.RemoveVolumes() option
- **Purpose**: Complete cleanup when deleting a session
- **Behavior**: Deletes both container and all associated data volumes
- **Use case**: Session deletion, permanent cleanup
- **Docker**: Removes container AND explicitly deletes the `octobot-data-{sessionID}` volume
- **VZ**: Removes VM and all associated storage (same as default)

```go
// Used during session deletion to clean up all resources
// Pass sandbox.RemoveVolumes() to delete volumes
if err := provider.Remove(ctx, sessionID, sandbox.RemoveVolumes()); err != nil {
    return err
}
```

### Docker Volume Management

Docker containers use named data volumes for persistent storage:

```go
// Volume naming
dataVolName := fmt.Sprintf("octobot-data-%s", sessionID)

// Volume is mounted at /.data inside container
Mounts: []mount.Mount{
    {
        Type:   mount.TypeVolume,
        Source: dataVolName,
        Target: "/.data",
    },
}
```

**Important**: Docker's `RemoveVolumes: true` flag only removes anonymous volumes, not named volumes. Named volumes must be explicitly deleted with `VolumeRemove()`.

## Sandbox Reconciliation

On server startup, reconcile sandboxes with database state:

```go
func (s *SandboxService) ReconcileSandboxes(ctx context.Context) error {
    // List all octobot sandboxes
    sandboxes, err := s.provider.List(ctx)
    if err != nil {
        return err
    }

    for _, sb := range sandboxes {
        session, err := s.store.GetSession(ctx, sb.SessionID)
        if err != nil || session.Status == "removing" {
            // Remove orphaned sandbox (preserves volumes for potential recovery)
            log.Printf("Removing orphaned sandbox: %s", sb.SessionID)
            s.provider.Remove(ctx, sb.SessionID)
        }
    }

    return nil
}
```

## Testing

```go
func TestDockerProvider_Create(t *testing.T) {
    if testing.Short() {
        t.Skip("Skipping Docker test in short mode")
    }

    provider, err := NewProvider(&config.Config{})
    require.NoError(t, err)

    ctx := context.Background()
    sessionID := uuid.New().String()

    sb, err := provider.Create(ctx, sessionID, Options{
        Image: "alpine:latest",
        Cmd:   []string{"sleep", "30"},
    })
    require.NoError(t, err)
    defer provider.Remove(ctx, sessionID)

    assert.NotEmpty(t, sb.ID)
    assert.Equal(t, "created", sb.Status)
}
```
