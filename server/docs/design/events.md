# Events Module

This module provides the event system for real-time updates via Server-Sent Events (SSE).

## Files

| File | Description |
|------|-------------|
| `internal/events/events.go` | Event broker and subscriber |
| `internal/events/poller.go` | Event polling worker |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Event System                              │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Services   │───▶│    Broker    │───▶│   Subscribers    │  │
│  │  (publish)   │    │              │    │   (clients)      │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│                    ┌──────────────┐                             │
│                    │   Database   │                             │
│                    │   (events)   │                             │
│                    └──────────────┘                             │
│                           │                                      │
│                           ▼                                      │
│                    ┌──────────────┐                             │
│                    │    Poller    │                             │
│                    │  (periodic)  │                             │
│                    └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

## Event Types

```go
type Event struct {
    ID        uint              `json:"id"`
    Type      string            `json:"type"`
    ProjectID string            `json:"projectId"`
    Payload   map[string]string `json:"payload"`
    CreatedAt time.Time         `json:"createdAt"`
}

const (
    EventSessionUpdated   = "session_updated"
    EventWorkspaceUpdated = "workspace_updated"
)
```

## Event Broker

### Structure

```go
type Broker struct {
    store       *store.Store
    subscribers map[string][]*Subscriber
    mu          sync.RWMutex
}

type Subscriber struct {
    ID        string
    ProjectID string
    Events    chan Event
    Done      chan struct{}
}

func NewBroker(store *store.Store) *Broker {
    return &Broker{
        store:       store,
        subscribers: make(map[string][]*Subscriber),
    }
}
```

### Subscribe

```go
func (b *Broker) Subscribe(projectID string) *Subscriber {
    b.mu.Lock()
    defer b.mu.Unlock()

    sub := &Subscriber{
        ID:        uuid.New().String(),
        ProjectID: projectID,
        Events:    make(chan Event, 100),
        Done:      make(chan struct{}),
    }

    b.subscribers[projectID] = append(b.subscribers[projectID], sub)
    return sub
}
```

### Unsubscribe

```go
func (b *Broker) Unsubscribe(sub *Subscriber) {
    b.mu.Lock()
    defer b.mu.Unlock()

    close(sub.Done)

    subs := b.subscribers[sub.ProjectID]
    for i, s := range subs {
        if s.ID == sub.ID {
            b.subscribers[sub.ProjectID] = append(subs[:i], subs[i+1:]...)
            break
        }
    }
}
```

### Publish

```go
func (b *Broker) Publish(event Event) error {
    // Store event in database
    dbEvent := &model.ProjectEvent{
        ProjectID: event.ProjectID,
        Type:      event.Type,
        Payload:   event.Payload,
    }
    if err := b.store.CreateEvent(context.Background(), dbEvent); err != nil {
        return err
    }

    // Broadcast to subscribers
    b.mu.RLock()
    defer b.mu.RUnlock()

    event.ID = dbEvent.ID
    event.CreatedAt = dbEvent.CreatedAt

    for _, sub := range b.subscribers[event.ProjectID] {
        select {
        case sub.Events <- event:
        default:
            // Channel full, skip
        }
    }

    return nil
}
```

### Broadcast (from Poller)

```go
func (b *Broker) Broadcast(projectID string, events []Event) {
    b.mu.RLock()
    defer b.mu.RUnlock()

    for _, sub := range b.subscribers[projectID] {
        for _, event := range events {
            select {
            case sub.Events <- event:
            case <-sub.Done:
                return
            default:
                // Channel full, skip
            }
        }
    }
}
```

## Event Poller

### Structure

```go
type Poller struct {
    store    *store.Store
    broker   *Broker
    interval time.Duration
    sequences map[string]uint // Last seen sequence per project
    mu        sync.Mutex
}

func NewPoller(store *store.Store, broker *Broker) *Poller {
    return &Poller{
        store:     store,
        broker:    broker,
        interval:  time.Second,
        sequences: make(map[string]uint),
    }
}
```

### Start

```go
func (p *Poller) Start(ctx context.Context) {
    ticker := time.NewTicker(p.interval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            p.poll(ctx)
        }
    }
}
```

### Poll

```go
func (p *Poller) poll(ctx context.Context) {
    p.mu.Lock()
    defer p.mu.Unlock()

    // Get all active project IDs from subscribers
    projectIDs := p.broker.GetActiveProjects()

    for _, projectID := range projectIDs {
        lastSeq := p.sequences[projectID]

        // Get new events
        events, err := p.store.GetEventsSince(ctx, projectID, lastSeq)
        if err != nil {
            continue
        }

        if len(events) == 0 {
            continue
        }

        // Update sequence
        p.sequences[projectID] = events[len(events)-1].ID

        // Convert and broadcast
        converted := make([]Event, len(events))
        for i, e := range events {
            converted[i] = Event{
                ID:        e.ID,
                Type:      e.Type,
                ProjectID: e.ProjectID,
                Payload:   e.Payload,
                CreatedAt: e.CreatedAt,
            }
        }

        p.broker.Broadcast(projectID, converted)
    }
}
```

## SSE Handler

```go
func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
    projectID := chi.URLParam(r, "projectId")

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.Header().Set("X-Accel-Buffering", "no")

    // Subscribe to events
    sub := h.broker.Subscribe(projectID)
    defer h.broker.Unsubscribe(sub)

    flusher, ok := w.(http.Flusher)
    if !ok {
        http.Error(w, "SSE not supported", http.StatusInternalServerError)
        return
    }

    // Send initial connection event
    fmt.Fprintf(w, "event: connected\ndata: {}\n\n")
    flusher.Flush()

    // Stream events
    for {
        select {
        case event := <-sub.Events:
            data, _ := json.Marshal(event)
            fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Type, data)
            flusher.Flush()

        case <-r.Context().Done():
            return

        case <-sub.Done:
            return
        }
    }
}
```

## Publishing Events

### From Services

```go
// SessionService
func (s *SessionService) UpdateStatus(ctx context.Context, id, status string) error {
    if err := s.store.UpdateSession(ctx, id, map[string]any{"status": status}); err != nil {
        return err
    }

    // Publish event
    session, _ := s.store.GetSession(ctx, id)
    s.broker.Publish(Event{
        Type:      EventSessionUpdated,
        ProjectID: session.ProjectID,
        Payload: map[string]string{
            "sessionId": id,
            "status":    status,
        },
    })

    return nil
}

// WorkspaceService
func (s *WorkspaceService) UpdateStatus(ctx context.Context, id, status string) error {
    if err := s.store.UpdateWorkspace(ctx, id, map[string]any{"status": status}); err != nil {
        return err
    }

    workspace, _ := s.store.GetWorkspace(ctx, id)
    s.broker.Publish(Event{
        Type:      EventWorkspaceUpdated,
        ProjectID: workspace.ProjectID,
        Payload: map[string]string{
            "workspaceId": id,
            "status":      status,
        },
    })

    return nil
}
```

## Frontend Integration

The frontend subscribes to events using `useProjectEvents`:

```typescript
// lib/hooks/use-project-events.ts
function useProjectEvents(options: UseProjectEventsOptions) {
  useEffect(() => {
    const eventSource = new EventSource(`/api/projects/${projectId}/events`)

    eventSource.addEventListener('session_updated', (e) => {
      const event = JSON.parse(e.data)
      options.onSessionUpdated?.(event.payload.sessionId)
    })

    eventSource.addEventListener('workspace_updated', (e) => {
      const event = JSON.parse(e.data)
      options.onWorkspaceUpdated?.(event.payload.workspaceId)
    })

    return () => eventSource.close()
  }, [projectId])
}
```

## Event Cleanup

Old events can be cleaned up periodically:

```go
func (s *Store) CleanupOldEvents(ctx context.Context, olderThan time.Duration) error {
    cutoff := time.Now().Add(-olderThan)
    return s.db.WithContext(ctx).
        Where("created_at < ?", cutoff).
        Delete(&ProjectEvent{}).Error
}
```

## Testing

```go
func TestBroker_PublishSubscribe(t *testing.T) {
    store := store.NewMock()
    broker := NewBroker(store)

    // Subscribe
    sub := broker.Subscribe("project-1")
    defer broker.Unsubscribe(sub)

    // Publish
    broker.Publish(Event{
        Type:      EventSessionUpdated,
        ProjectID: "project-1",
        Payload:   map[string]string{"sessionId": "session-1"},
    })

    // Receive
    select {
    case event := <-sub.Events:
        assert.Equal(t, EventSessionUpdated, event.Type)
        assert.Equal(t, "session-1", event.Payload["sessionId"])
    case <-time.After(time.Second):
        t.Fatal("Timeout waiting for event")
    }
}
```
