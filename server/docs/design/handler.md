# Handler Module

This module implements HTTP request handlers for all REST API endpoints.

## Files

| File | Description |
|------|-------------|
| `internal/handler/handler.go` | Base handler struct and helpers |
| `internal/handler/auth.go` | Authentication endpoints |
| `internal/handler/projects.go` | Project CRUD |
| `internal/handler/workspaces.go` | Workspace CRUD and git ops |
| `internal/handler/sessions.go` | Session CRUD |
| `internal/handler/agents.go` | Agent CRUD and types |
| `internal/handler/chat.go` | Chat streaming endpoint |
| `internal/handler/credentials.go` | Credential management |
| `internal/handler/files.go` | File operations |
| `internal/handler/terminal.go` | Terminal WebSocket |
| `internal/handler/git.go` | Git operations |
| `internal/handler/events.go` | SSE event streaming |
| `internal/handler/status.go` | Health check |

## Base Handler

### Structure

```go
type Handler struct {
    config           *config.Config
    store            *store.Store
    services         *service.Services
    eventBroker      *events.Broker
    containerRuntime container.Runtime
    gitProvider      git.Provider
}

func New(
    cfg *config.Config,
    store *store.Store,
    services *service.Services,
    broker *events.Broker,
) *Handler
```

### Helper Methods

```go
// JSON response
func (h *Handler) JSON(w http.ResponseWriter, data any, status int)

// Error response
func (h *Handler) Error(w http.ResponseWriter, err error, status int)

// Decode JSON body
func (h *Handler) DecodeJSON(r *http.Request, v any) error

// Get path parameter
func (h *Handler) PathParam(r *http.Request, key string) string
```

## Route Registration

```go
func (h *Handler) RegisterRoutes(r chi.Router) {
    // Public routes
    r.Get("/api/status", h.GetStatus)
    r.Get("/auth/login/{provider}", h.Login)
    r.Get("/auth/callback/{provider}", h.Callback)

    // Protected routes
    r.Group(func(r chi.Router) {
        r.Use(h.authMiddleware)

        // Projects
        r.Get("/api/projects", h.ListProjects)
        r.Post("/api/projects", h.CreateProject)

        // Project-scoped routes
        r.Route("/api/projects/{projectId}", func(r chi.Router) {
            r.Use(h.projectMiddleware)

            // Workspaces
            r.Get("/workspaces", h.ListWorkspaces)
            r.Post("/workspaces", h.CreateWorkspace)
            r.Get("/workspaces/{workspaceId}", h.GetWorkspace)
            r.Delete("/workspaces/{workspaceId}", h.DeleteWorkspace)

            // Sessions
            r.Get("/sessions/{sessionId}", h.GetSession)
            r.Put("/sessions/{sessionId}", h.UpdateSession)
            r.Delete("/sessions/{sessionId}", h.DeleteSession)

            // Agents
            r.Get("/agents", h.ListAgents)
            r.Post("/agents", h.CreateAgent)
            r.Get("/agents/types", h.ListAgentTypes)

            // Chat
            r.Post("/chat", h.Chat)

            // Events
            r.Get("/events", h.Events)
        })
    })
}
```

## Handler Implementations

### Authentication Handlers (auth.go)

```go
// GET /auth/login/{provider}
func (h *Handler) Login(w http.ResponseWriter, r *http.Request)
// Initiates OAuth flow, redirects to provider

// GET /auth/callback/{provider}
func (h *Handler) Callback(w http.ResponseWriter, r *http.Request)
// Handles OAuth callback, creates session

// POST /auth/logout
func (h *Handler) Logout(w http.ResponseWriter, r *http.Request)
// Clears session cookie

// GET /auth/me
func (h *Handler) Me(w http.ResponseWriter, r *http.Request)
// Returns current user info
```

### Workspace Handlers (workspaces.go)

```go
// GET /api/projects/{projectId}/workspaces
func (h *Handler) ListWorkspaces(w http.ResponseWriter, r *http.Request) {
    projectID := h.PathParam(r, "projectId")
    workspaces, err := h.store.ListWorkspaces(r.Context(), projectID)
    if err != nil {
        h.Error(w, err, http.StatusInternalServerError)
        return
    }
    h.JSON(w, workspaces, http.StatusOK)
}

// POST /api/projects/{projectId}/workspaces
func (h *Handler) CreateWorkspace(w http.ResponseWriter, r *http.Request) {
    var req CreateWorkspaceRequest
    if err := h.DecodeJSON(r, &req); err != nil {
        h.Error(w, err, http.StatusBadRequest)
        return
    }

    workspace, err := h.services.Workspace.Create(r.Context(), req)
    if err != nil {
        h.Error(w, err, http.StatusInternalServerError)
        return
    }

    // Enqueue initialization job
    h.services.Jobs.EnqueueWorkspaceInit(workspace.ID)

    h.JSON(w, workspace, http.StatusCreated)
}
```

### Chat Handler (chat.go)

```go
// POST /api/projects/{projectId}/chat
func (h *Handler) Chat(w http.ResponseWriter, r *http.Request) {
    var req ChatRequest
    if err := h.DecodeJSON(r, &req); err != nil {
        h.Error(w, err, http.StatusBadRequest)
        return
    }

    // Create or get session
    session, err := h.services.Chat.EnsureSession(r.Context(), req)
    if err != nil {
        h.Error(w, err, http.StatusInternalServerError)
        return
    }

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Get SSE stream from container
    stream, err := h.services.Chat.SendToContainer(r.Context(), session, req.Messages)
    if err != nil {
        h.Error(w, err, http.StatusInternalServerError)
        return
    }

    // Proxy stream to client
    flusher := w.(http.Flusher)
    for line := range stream {
        fmt.Fprintf(w, "%s\n", line)
        flusher.Flush()
    }
}
```

### Events Handler (events.go)

```go
// GET /api/projects/{projectId}/events
func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
    projectID := h.PathParam(r, "projectId")

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")

    // Subscribe to events
    subscriber := h.eventBroker.Subscribe(projectID)
    defer h.eventBroker.Unsubscribe(subscriber)

    flusher := w.(http.Flusher)

    // Stream events
    for {
        select {
        case event := <-subscriber.Events:
            data, _ := json.Marshal(event)
            fmt.Fprintf(w, "data: %s\n\n", data)
            flusher.Flush()

        case <-r.Context().Done():
            return
        }
    }
}
```

## Request/Response Types

### Workspace Types

```go
type CreateWorkspaceRequest struct {
    Name    string `json:"name"`
    Path    string `json:"path,omitempty"`
    GitRepo string `json:"gitRepo,omitempty"`
}

type WorkspaceResponse struct {
    ID        string            `json:"id"`
    Name      string            `json:"name"`
    Path      string            `json:"path,omitempty"`
    GitRepo   string            `json:"gitRepo,omitempty"`
    Status    string            `json:"status"`
    Sessions  []SessionResponse `json:"sessions"`
    CreatedAt time.Time         `json:"createdAt"`
}
```

### Session Types

```go
type SessionResponse struct {
    ID          string    `json:"id"`
    Name        string    `json:"name"`
    WorkspaceID string    `json:"workspaceId"`
    AgentID     string    `json:"agentId"`
    Status      string    `json:"status"`
    CreatedAt   time.Time `json:"createdAt"`
}

type UpdateSessionRequest struct {
    Name   string `json:"name,omitempty"`
    Status string `json:"status,omitempty"`
}
```

### Chat Types

```go
type ChatRequest struct {
    ID          string      `json:"id,omitempty"`
    WorkspaceID string      `json:"workspaceId"`
    AgentID     string      `json:"agentId"`
    Messages    []UIMessage `json:"messages"`
}
```

## Error Handling

```go
func (h *Handler) handleError(w http.ResponseWriter, err error) {
    switch {
    case errors.Is(err, store.ErrNotFound):
        h.Error(w, err, http.StatusNotFound)
    case errors.Is(err, service.ErrUnauthorized):
        h.Error(w, err, http.StatusUnauthorized)
    case errors.Is(err, service.ErrForbidden):
        h.Error(w, err, http.StatusForbidden)
    case errors.Is(err, service.ErrValidation):
        h.Error(w, err, http.StatusBadRequest)
    default:
        h.Error(w, err, http.StatusInternalServerError)
    }
}
```

## Middleware

### Auth Middleware

```go
func (h *Handler) authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if !h.config.AuthEnabled {
            // Use anonymous user
            ctx := context.WithValue(r.Context(), userKey, anonymousUser)
            next.ServeHTTP(w, r.WithContext(ctx))
            return
        }

        // Validate session cookie
        user, err := h.services.Auth.ValidateSession(r)
        if err != nil {
            h.Error(w, err, http.StatusUnauthorized)
            return
        }

        ctx := context.WithValue(r.Context(), userKey, user)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### Project Middleware

```go
func (h *Handler) projectMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        projectID := chi.URLParam(r, "projectId")
        user := r.Context().Value(userKey).(*model.User)

        // Check membership
        if !h.services.Project.IsMember(r.Context(), projectID, user.ID) {
            h.Error(w, ErrForbidden, http.StatusForbidden)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

## Testing

```go
func TestListWorkspaces(t *testing.T) {
    h := setupTestHandler(t)

    req := httptest.NewRequest("GET", "/api/projects/test/workspaces", nil)
    w := httptest.NewRecorder()

    h.ListWorkspaces(w, req)

    assert.Equal(t, http.StatusOK, w.Code)

    var workspaces []WorkspaceResponse
    json.Unmarshal(w.Body.Bytes(), &workspaces)
    assert.NotEmpty(t, workspaces)
}
```
