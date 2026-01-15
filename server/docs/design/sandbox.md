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

    // Remove a sandbox
    Remove(ctx context.Context, sessionID string) error

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

```go
func (p *Provider) Attach(
    ctx context.Context,
    sessionID string,
    opts AttachOptions,
) (PTY, error) {
    name := p.sandboxName(sessionID)

    resp, err := p.client.ContainerAttach(ctx, name, dockercontainer.AttachOptions{
        Stream: true,
        Stdin:  true,
        Stdout: true,
        Stderr: true,
        Tty:    true,
    })
    if err != nil {
        return nil, err
    }

    return &dockerPTY{
        conn:      resp.Conn,
        client:    p.client,
        container: name,
    }, nil
}
```

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
        if err != nil || session.Status == "closed" {
            // Remove orphaned sandbox
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
