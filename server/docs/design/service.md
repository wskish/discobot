# Service Module

This module implements business logic, orchestrating between handlers, store, and external services.

## Files

| File | Description |
|------|-------------|
| `internal/service/auth.go` | Authentication logic |
| `internal/service/project.go` | Project management |
| `internal/service/workspace.go` | Workspace lifecycle |
| `internal/service/session.go` | Session management |
| `internal/service/agent.go` | Agent configuration |
| `internal/service/chat.go` | Chat routing |
| `internal/service/container.go` | Container lifecycle |
| `internal/service/container_client.go` | Container HTTP client |
| `internal/service/credential.go` | Credential encryption |
| `internal/service/git.go` | Git operations |

## Service Container

```go
type Services struct {
    Auth       *AuthService
    Project    *ProjectService
    Workspace  *WorkspaceService
    Session    *SessionService
    Agent      *AgentService
    Chat       *ChatService
    Container  *ContainerService
    Credential *CredentialService
    Git        *GitService
}

func NewServices(
    store *store.Store,
    gitProvider git.Provider,
    containerRuntime container.Runtime,
    config *config.Config,
) *Services
```

## Auth Service

### Responsibilities

- User creation and lookup
- Session token management
- OAuth flow handling

### Key Methods

```go
// Create or get user from OAuth provider
func (s *AuthService) GetOrCreateUser(
    ctx context.Context,
    provider string,
    providerID string,
    email string,
) (*model.User, error)

// Create session and return token
func (s *AuthService) CreateSession(
    ctx context.Context,
    userID string,
) (string, error)

// Validate session token from cookie
func (s *AuthService) ValidateSession(r *http.Request) (*model.User, error)
```

## Workspace Service

### Responsibilities

- Workspace CRUD operations
- Git repository setup
- Initialization orchestration

### Key Methods

```go
// Create workspace and enqueue init job
func (s *WorkspaceService) Create(
    ctx context.Context,
    projectID string,
    req CreateWorkspaceRequest,
) (*model.Workspace, error) {
    workspace := &model.Workspace{
        ID:        uuid.New().String(),
        ProjectID: projectID,
        Name:      req.Name,
        Path:      req.Path,
        GitRepo:   req.GitRepo,
        Status:    "initializing",
    }

    if err := s.store.CreateWorkspace(ctx, workspace); err != nil {
        return nil, err
    }

    return workspace, nil
}

// Initialize workspace (called by job executor)
func (s *WorkspaceService) Initialize(
    ctx context.Context,
    workspaceID string,
) error {
    workspace, err := s.store.GetWorkspace(ctx, workspaceID)
    if err != nil {
        return err
    }

    // Setup workspace directory
    if workspace.GitRepo != "" {
        err = s.gitProvider.Clone(ctx, workspace.GitRepo, workspace.Path)
    } else {
        err = s.gitProvider.EnsureDirectory(ctx, workspace.Path)
    }

    if err != nil {
        s.store.UpdateWorkspace(ctx, workspaceID, map[string]any{
            "status": "error",
        })
        return err
    }

    return s.store.UpdateWorkspace(ctx, workspaceID, map[string]any{
        "status": "ready",
    })
}
```

## Session Service

### Responsibilities

- Session CRUD operations
- Container lifecycle integration
- Session-to-response mapping

### Key Methods

```go
// Create session with optional client ID
func (s *SessionService) Create(
    ctx context.Context,
    workspaceID string,
    agentID string,
    clientID string,
) (*model.Session, error) {
    id := clientID
    if id == "" {
        id = uuid.New().String()
    }

    session := &model.Session{
        ID:          id,
        WorkspaceID: workspaceID,
        AgentID:     agentID,
        Status:      "initializing",
    }

    if err := s.store.CreateSession(ctx, session); err != nil {
        return nil, err
    }

    return session, nil
}

// Initialize session (create container)
func (s *SessionService) Initialize(
    ctx context.Context,
    sessionID string,
) error {
    session, err := s.store.GetSession(ctx, sessionID)
    if err != nil {
        return err
    }

    // Get workspace for mount path
    workspace, err := s.store.GetWorkspace(ctx, session.WorkspaceID)
    if err != nil {
        return err
    }

    // Create container
    container, err := s.containerService.Create(ctx, sessionID, container.Options{
        Image: s.config.ContainerImage,
        Binds: []string{
            fmt.Sprintf("%s:/workspace:rw", workspace.Path),
        },
    })
    if err != nil {
        s.store.UpdateSession(ctx, sessionID, map[string]any{
            "status": "error",
        })
        return err
    }

    return s.store.UpdateSession(ctx, sessionID, map[string]any{
        "status":       "running",
        "container_id": container.ID,
    })
}
```

## Chat Service

### Responsibilities

- Session creation on first message
- Message routing to containers
- Response streaming

### Key Methods

```go
// Ensure session exists, create if needed
func (s *ChatService) EnsureSession(
    ctx context.Context,
    req ChatRequest,
) (*model.Session, error) {
    if req.ID != "" {
        // Try to get existing session
        session, err := s.store.GetSession(ctx, req.ID)
        if err == nil {
            return session, nil
        }
    }

    // Create new session
    return s.sessionService.Create(ctx, req.WorkspaceID, req.AgentID, req.ID)
}

// Send messages to container, return SSE stream
func (s *ChatService) SendToContainer(
    ctx context.Context,
    session *model.Session,
    messages []UIMessage,
) (<-chan string, error) {
    // Get container address
    container, err := s.containerService.Get(ctx, session.ID)
    if err != nil {
        return nil, err
    }

    // Create HTTP client
    client := NewContainerClient(container.Address)

    // Send messages and return stream
    return client.SendMessages(ctx, messages)
}
```

## Container Service

### Responsibilities

- Container lifecycle (create, start, stop, remove)
- Container reconciliation on startup
- Container health checks

### Key Methods

```go
// Create and start container
func (s *ContainerService) Create(
    ctx context.Context,
    sessionID string,
    opts container.Options,
) (*container.Container, error) {
    c, err := s.runtime.Create(ctx, sessionID, opts)
    if err != nil {
        return nil, err
    }

    if err := s.runtime.Start(ctx, sessionID); err != nil {
        s.runtime.Remove(ctx, sessionID)
        return nil, err
    }

    return c, nil
}

// Reconcile containers with database state
func (s *ContainerService) Reconcile(ctx context.Context) error {
    // List all containers
    containers, err := s.runtime.List(ctx)
    if err != nil {
        return err
    }

    // Check each against database
    for _, c := range containers {
        session, err := s.store.GetSession(ctx, c.SessionID)
        if err != nil || session.Status == "closed" {
            // Remove orphaned container
            s.runtime.Remove(ctx, c.SessionID)
        }
    }

    return nil
}
```

## Container Client

### Responsibilities

- HTTP communication with container agent
- SSE stream parsing
- Error handling

### Implementation

```go
type ContainerClient struct {
    baseURL string
    client  *http.Client
}

func (c *ContainerClient) SendMessages(
    ctx context.Context,
    messages []UIMessage,
) (<-chan string, error) {
    // Create request
    body, _ := json.Marshal(map[string]any{
        "messages": messages,
    })

    req, _ := http.NewRequestWithContext(ctx, "POST",
        c.baseURL+"/chat",
        bytes.NewReader(body),
    )
    req.Header.Set("Content-Type", "application/json")

    // Send request
    resp, err := c.client.Do(req)
    if err != nil {
        return nil, err
    }

    // Return stream channel
    ch := make(chan string)
    go func() {
        defer close(ch)
        defer resp.Body.Close()

        scanner := bufio.NewScanner(resp.Body)
        for scanner.Scan() {
            ch <- scanner.Text()
        }
    }()

    return ch, nil
}
```

## Credential Service

### Responsibilities

- Credential encryption/decryption
- Secure storage and retrieval

### Implementation

```go
// Store encrypted credential
func (s *CredentialService) Create(
    ctx context.Context,
    projectID string,
    req CreateCredentialRequest,
) (*model.Credential, error) {
    // Encrypt value
    encrypted, err := s.encrypt(req.Value)
    if err != nil {
        return nil, err
    }

    cred := &model.Credential{
        ID:             uuid.New().String(),
        ProjectID:      projectID,
        Provider:       req.Provider,
        EncryptedValue: encrypted,
    }

    return cred, s.store.CreateCredential(ctx, cred)
}

// Decrypt and return credential value
func (s *CredentialService) Decrypt(
    ctx context.Context,
    credentialID string,
) (string, error) {
    cred, err := s.store.GetCredential(ctx, credentialID)
    if err != nil {
        return "", err
    }

    return s.decrypt(cred.EncryptedValue)
}
```

## Git Service

### Responsibilities

- Wrap git provider for services
- Git operation orchestration

### Implementation

```go
type GitService struct {
    provider git.Provider
}

func (s *GitService) Clone(ctx context.Context, repo, path string) error {
    return s.provider.Clone(ctx, repo, path)
}

func (s *GitService) Diff(ctx context.Context, path string) (string, error) {
    return s.provider.Diff(ctx, path)
}

func (s *GitService) FileTree(ctx context.Context, path, ref string) ([]FileNode, error) {
    return s.provider.FileTree(ctx, path, ref)
}
```

## Error Types

```go
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrForbidden    = errors.New("forbidden")
    ErrValidation   = errors.New("validation failed")
)
```

## Testing

```go
func TestWorkspaceService_Create(t *testing.T) {
    store := store.NewMock()
    service := NewWorkspaceService(store, nil)

    req := CreateWorkspaceRequest{
        Name: "Test Workspace",
        Path: "/tmp/test",
    }

    workspace, err := service.Create(context.Background(), "project-1", req)

    assert.NoError(t, err)
    assert.Equal(t, "Test Workspace", workspace.Name)
    assert.Equal(t, "initializing", workspace.Status)
}
```
