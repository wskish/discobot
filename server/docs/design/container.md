# Container Module

This module provides the container runtime abstraction for managing Docker containers.

## Files

| File | Description |
|------|-------------|
| `internal/container/runtime.go` | Runtime interface definition |
| `internal/container/errors.go` | Error types |
| `internal/container/docker/provider.go` | Docker implementation |
| `internal/container/mock/provider.go` | Mock implementation for testing |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Container Abstraction                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Runtime Interface                       │  │
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

## Runtime Interface

```go
type Runtime interface {
    // Create a new container
    Create(ctx context.Context, sessionID string, opts Options) (*Container, error)

    // Start a container
    Start(ctx context.Context, sessionID string) error

    // Stop a container
    Stop(ctx context.Context, sessionID string, timeout time.Duration) error

    // Remove a container
    Remove(ctx context.Context, sessionID string) error

    // Get container info
    Get(ctx context.Context, sessionID string) (*Container, error)

    // List all containers
    List(ctx context.Context) ([]*Container, error)

    // Execute command in container
    Exec(ctx context.Context, sessionID string, cmd []string, opts ExecOptions) (*ExecResult, error)

    // Attach to container (PTY)
    Attach(ctx context.Context, sessionID string, opts AttachOptions) (PTY, error)
}
```

## Types

### Container

```go
type Container struct {
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
type DockerProvider struct {
    client *client.Client
    config *config.Config
}

func NewDockerProvider(cfg *config.Config) (*DockerProvider, error) {
    cli, err := client.NewClientWithOpts(
        client.FromEnv,
        client.WithAPIVersionNegotiation(),
    )
    if err != nil {
        return nil, err
    }

    return &DockerProvider{
        client: cli,
        config: cfg,
    }, nil
}
```

### Container Naming

```go
func (p *DockerProvider) containerName(sessionID string) string {
    return fmt.Sprintf("octobot-session-%s", sessionID)
}
```

### Create

```go
func (p *DockerProvider) Create(
    ctx context.Context,
    sessionID string,
    opts Options,
) (*Container, error) {
    name := p.containerName(sessionID)

    // Container config
    containerConfig := &dockercontainer.Config{
        Image: opts.Image,
        Cmd:   opts.Cmd,
        Env:   opts.Env,
        Labels: map[string]string{
            "octobot.session": sessionID,
        },
        ExposedPorts: nat.PortSet{
            "8080/tcp": struct{}{},
        },
    }

    // Host config
    hostConfig := &dockercontainer.HostConfig{
        Binds:       opts.Binds,
        NetworkMode: dockercontainer.NetworkMode(opts.NetworkMode),
        PortBindings: nat.PortMap{
            "8080/tcp": []nat.PortBinding{
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

    return &Container{
        ID:        resp.ID,
        SessionID: sessionID,
        Status:    "created",
    }, nil
}
```

### Start

```go
func (p *DockerProvider) Start(ctx context.Context, sessionID string) error {
    name := p.containerName(sessionID)
    return p.client.ContainerStart(ctx, name, dockercontainer.StartOptions{})
}
```

### Get with Address

```go
func (p *DockerProvider) Get(ctx context.Context, sessionID string) (*Container, error) {
    name := p.containerName(sessionID)

    info, err := p.client.ContainerInspect(ctx, name)
    if err != nil {
        return nil, err
    }

    // Get assigned port
    bindings := info.NetworkSettings.Ports["8080/tcp"]
    address := ""
    if len(bindings) > 0 {
        address = fmt.Sprintf("http://127.0.0.1:%s", bindings[0].HostPort)
    }

    return &Container{
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
func (p *DockerProvider) Attach(
    ctx context.Context,
    sessionID string,
    opts AttachOptions,
) (PTY, error) {
    name := p.containerName(sessionID)

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
func (p *DockerProvider) Exec(
    ctx context.Context,
    sessionID string,
    cmd []string,
    opts ExecOptions,
) (*ExecResult, error) {
    name := p.containerName(sessionID)

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
    containers map[string]*Container
    mu         sync.RWMutex
}

func NewMockProvider() *MockProvider {
    return &MockProvider{
        containers: make(map[string]*Container),
    }
}

func (m *MockProvider) Create(
    ctx context.Context,
    sessionID string,
    opts Options,
) (*Container, error) {
    m.mu.Lock()
    defer m.mu.Unlock()

    c := &Container{
        ID:        uuid.New().String(),
        SessionID: sessionID,
        Status:    "created",
        Address:   "http://mock:8080",
        CreatedAt: time.Now(),
    }

    m.containers[sessionID] = c
    return c, nil
}
```

## Error Types

```go
var (
    ErrContainerNotFound = errors.New("container not found")
    ErrContainerStopped  = errors.New("container is stopped")
    ErrExecFailed        = errors.New("exec failed")
)
```

## Container Labels

Labels are used to identify Octobot containers:

```go
labels := map[string]string{
    "octobot":         "true",
    "octobot.session": sessionID,
    "octobot.project": projectID,
}
```

## Container Reconciliation

On server startup, reconcile containers with database state:

```go
func (s *ContainerService) Reconcile(ctx context.Context) error {
    // List all octobot containers
    containers, err := s.runtime.List(ctx)
    if err != nil {
        return err
    }

    for _, c := range containers {
        session, err := s.store.GetSession(ctx, c.SessionID)
        if err != nil || session.Status == "closed" {
            // Remove orphaned container
            log.Printf("Removing orphaned container: %s", c.SessionID)
            s.runtime.Remove(ctx, c.SessionID)
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

    provider, err := NewDockerProvider(&config.Config{})
    require.NoError(t, err)

    ctx := context.Background()
    sessionID := uuid.New().String()

    c, err := provider.Create(ctx, sessionID, Options{
        Image: "alpine:latest",
        Cmd:   []string{"sleep", "30"},
    })
    require.NoError(t, err)
    defer provider.Remove(ctx, sessionID)

    assert.NotEmpty(t, c.ID)
    assert.Equal(t, "created", c.Status)
}
```
