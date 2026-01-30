// Package events provides a Server-Sent Events (SSE) system backed by database persistence.
// Events are written to the database and then polled and broadcast to subscribers.
package events

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/store"
)

// EventType represents the type of event being broadcast
type EventType string

const (
	// EventTypeSessionUpdated indicates a session's state has changed
	EventTypeSessionUpdated EventType = "session_updated"
	// EventTypeWorkspaceUpdated indicates a workspace's state has changed
	EventTypeWorkspaceUpdated EventType = "workspace_updated"
)

// Event represents a server-sent event
type Event struct {
	ID        string          `json:"id"`
	Seq       int64           `json:"seq"`
	Type      EventType       `json:"type"`
	Timestamp time.Time       `json:"timestamp"`
	Data      json.RawMessage `json:"data"`
}

// FromModel converts a model.ProjectEvent to an Event
func FromModel(e *model.ProjectEvent) *Event {
	return &Event{
		ID:        e.ID,
		Seq:       e.Seq,
		Type:      EventType(e.Type),
		Timestamp: e.CreatedAt,
		Data:      e.Data,
	}
}

// SessionUpdatedData is the payload for session_updated events
type SessionUpdatedData struct {
	SessionID    string `json:"sessionId"`
	Status       string `json:"status"`
	CommitStatus string `json:"commitStatus,omitempty"`
}

// WorkspaceUpdatedData is the payload for workspace_updated events
type WorkspaceUpdatedData struct {
	WorkspaceID string `json:"workspaceId"`
	Status      string `json:"status"`
}

// Subscriber represents a client subscribed to events for a specific project.
type Subscriber struct {
	ID        string
	ProjectID string
	Events    chan *Event
	done      chan struct{}
	isClosed  bool
	mu        sync.Mutex
}

// Close closes the subscriber's event channel
func (s *Subscriber) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.isClosed {
		s.isClosed = true
		close(s.done)
		close(s.Events)
	}
}

// Done returns a channel that's closed when the subscriber is closed
func (s *Subscriber) Done() <-chan struct{} {
	return s.done
}

// Broker manages event publishing and subscription through the database.
// Events are persisted to the database first, then the poller picks them up
// and broadcasts to subscribers.
type Broker struct {
	store  *store.Store
	poller *Poller
}

// NewBroker creates a new event broker.
// The poller should be started separately via poller.Start().
func NewBroker(s *store.Store, poller *Poller) *Broker {
	return &Broker{
		store:  s,
		poller: poller,
	}
}

// Subscribe creates a new subscription for a project's events.
// Events are delivered through the returned Subscriber's Events channel.
func (b *Broker) Subscribe(projectID string) *Subscriber {
	return b.poller.Subscribe(projectID)
}

// Unsubscribe removes a subscription.
func (b *Broker) Unsubscribe(sub *Subscriber) {
	b.poller.Unsubscribe(sub)
}

// Publish persists an event to the database and notifies the poller.
// The event will be broadcast to subscribers by the poller.
func (b *Broker) Publish(ctx context.Context, projectID string, event *Event) error {
	// Persist event to database
	modelEvent := &model.ProjectEvent{
		ID:        event.ID,
		ProjectID: projectID,
		Type:      string(event.Type),
		Data:      event.Data,
	}
	if err := b.store.CreateProjectEvent(ctx, modelEvent); err != nil {
		return fmt.Errorf("failed to persist event: %w", err)
	}

	// Update event with assigned sequence number
	event.Seq = modelEvent.Seq

	// Notify poller to pick up the event immediately
	b.poller.NotifyNewEvent()

	return nil
}

// PublishSessionUpdated is a convenience method to publish session update events.
// Both status and commitStatus are sent as separate fields to the client.
func (b *Broker) PublishSessionUpdated(ctx context.Context, projectID, sessionID, status, commitStatus string) error {
	data := SessionUpdatedData{
		SessionID:    sessionID,
		Status:       status,
		CommitStatus: commitStatus,
	}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to marshal event data: %w", err)
	}

	event := &Event{
		ID:        generateEventID(),
		Type:      EventTypeSessionUpdated,
		Timestamp: time.Now(),
		Data:      dataBytes,
	}

	return b.Publish(ctx, projectID, event)
}

// PublishWorkspaceUpdated is a convenience method to publish workspace update events.
func (b *Broker) PublishWorkspaceUpdated(ctx context.Context, projectID, workspaceID, status string) error {
	data := WorkspaceUpdatedData{
		WorkspaceID: workspaceID,
		Status:      status,
	}

	dataBytes, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("failed to marshal event data: %w", err)
	}

	event := &Event{
		ID:        generateEventID(),
		Type:      EventTypeWorkspaceUpdated,
		Timestamp: time.Now(),
		Data:      dataBytes,
	}

	return b.Publish(ctx, projectID, event)
}

// GetEventsSince returns all persisted events for a project since the given time.
func (b *Broker) GetEventsSince(ctx context.Context, projectID string, since time.Time) ([]*Event, error) {
	modelEvents, err := b.store.ListProjectEventsSince(ctx, projectID, since)
	if err != nil {
		return nil, err
	}

	events := make([]*Event, len(modelEvents))
	for i, e := range modelEvents {
		events[i] = FromModel(&e)
	}
	return events, nil
}

// GetEventsAfterID returns all persisted events for a project after the given event ID.
func (b *Broker) GetEventsAfterID(ctx context.Context, projectID, afterID string) ([]*Event, error) {
	modelEvents, err := b.store.ListProjectEventsAfterID(ctx, projectID, afterID)
	if err != nil {
		return nil, err
	}

	events := make([]*Event, len(modelEvents))
	for i, e := range modelEvents {
		events[i] = FromModel(&e)
	}
	return events, nil
}

// generateEventID creates a unique event ID
func generateEventID() string {
	return time.Now().Format("20060102150405.000000000")
}
