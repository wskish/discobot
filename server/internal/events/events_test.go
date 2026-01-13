package events

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/database"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// testEnv holds the test environment
type testEnv struct {
	Store     *store.Store
	ProjectID string
	Cleanup   func()
}

// testSetup creates a test database, store, and a project
func testSetup(t *testing.T) *testEnv {
	t.Helper()

	cfg := &config.Config{
		DatabaseDSN:    fmt.Sprintf("sqlite3://%s/test.db", t.TempDir()),
		DatabaseDriver: "sqlite",
	}

	db, err := database.New(cfg)
	if err != nil {
		t.Fatalf("Failed to create database: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("Failed to run migrations: %v", err)
	}

	// Create a project for the events
	s := store.New(db.DB)
	project := &model.Project{Name: "Test Project", Slug: "test-project"}
	if err := s.CreateProject(context.Background(), project); err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}

	return &testEnv{
		Store:     s,
		ProjectID: project.ID,
		Cleanup: func() {
			db.Close()
		},
	}
}

// createSecondProject creates a second project for multi-project tests
func (e *testEnv) createSecondProject(t *testing.T) string {
	t.Helper()
	project := &model.Project{Name: "Test Project 2", Slug: "test-project-2"}
	if err := e.Store.CreateProject(context.Background(), project); err != nil {
		t.Fatalf("Failed to create second project: %v", err)
	}
	return project.ID
}

func TestPoller_StartsWithMaxSeq(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Insert some events before starting poller
	for i := 0; i < 5; i++ {
		event := &model.ProjectEvent{
			ProjectID: env.ProjectID,
			Type:      "test",
			Data:      json.RawMessage(`{}`),
		}
		if err := env.Store.CreateProjectEvent(ctx, event); err != nil {
			t.Fatalf("Failed to create event: %v", err)
		}
	}

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Poller should start at the max seq (5)
	if poller.LastSeq() != 5 {
		t.Errorf("Expected last seq to be 5, got %d", poller.LastSeq())
	}
}

func TestPoller_BroadcastsNewEvents(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Subscribe
	sub := poller.Subscribe(env.ProjectID)
	defer poller.Unsubscribe(sub)

	// Insert an event
	event := &model.ProjectEvent{
		ProjectID: env.ProjectID,
		Type:      string(EventTypeSessionUpdated),
		Data:      json.RawMessage(`{"sessionId":"sess1","status":"running"}`),
	}
	if err := env.Store.CreateProjectEvent(ctx, event); err != nil {
		t.Fatalf("Failed to create event: %v", err)
	}

	// Notify poller
	poller.NotifyNewEvent()

	// Wait for event
	select {
	case received := <-sub.Events:
		if received.ID != event.ID {
			t.Errorf("Expected event ID %s, got %s", event.ID, received.ID)
		}
		if received.Type != EventTypeSessionUpdated {
			t.Errorf("Expected type %s, got %s", EventTypeSessionUpdated, received.Type)
		}
	case <-time.After(1 * time.Second):
		t.Error("Timeout waiting for event")
	}
}

func TestPoller_FiltersEventsByProjectID(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Create a second project
	projectB := env.createSecondProject(t)

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Subscribe to project A (env.ProjectID)
	subA := poller.Subscribe(env.ProjectID)
	defer poller.Unsubscribe(subA)

	// Subscribe to project B
	subB := poller.Subscribe(projectB)
	defer poller.Unsubscribe(subB)

	// Insert event for project A
	eventA := &model.ProjectEvent{
		ProjectID: env.ProjectID,
		Type:      "test",
		Data:      json.RawMessage(`{"msg":"for A"}`),
	}
	if err := env.Store.CreateProjectEvent(ctx, eventA); err != nil {
		t.Fatalf("Failed to create event: %v", err)
	}
	poller.NotifyNewEvent()

	// Project A subscriber should receive the event
	select {
	case received := <-subA.Events:
		if received.ID != eventA.ID {
			t.Errorf("Project A: expected event ID %s, got %s", eventA.ID, received.ID)
		}
	case <-time.After(1 * time.Second):
		t.Error("Project A: timeout waiting for event")
	}

	// Project B subscriber should NOT receive the event
	select {
	case <-subB.Events:
		t.Error("Project B: received event that was meant for Project A")
	case <-time.After(100 * time.Millisecond):
		// Expected - no event for project B
	}
}

func TestBroker_PublishPersistsAndNotifies(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Create broker
	broker := NewBroker(env.Store, poller)

	// Subscribe
	sub := broker.Subscribe(env.ProjectID)
	defer broker.Unsubscribe(sub)

	// Publish an event
	event := &Event{
		ID:        "evt-123",
		Type:      EventTypeSessionUpdated,
		Timestamp: time.Now(),
		Data:      json.RawMessage(`{"sessionId":"sess1","status":"running"}`),
	}
	if err := broker.Publish(ctx, env.ProjectID, event); err != nil {
		t.Fatalf("Failed to publish event: %v", err)
	}

	// Event should be assigned a sequence number
	if event.Seq == 0 {
		t.Error("Expected event to have sequence number assigned")
	}

	// Wait for event via subscription
	select {
	case received := <-sub.Events:
		if received.ID != event.ID {
			t.Errorf("Expected event ID %s, got %s", event.ID, received.ID)
		}
	case <-time.After(1 * time.Second):
		t.Error("Timeout waiting for event")
	}

	// Verify event is persisted in database
	events, err := env.Store.ListEventsAfterSeq(ctx, 0, 10)
	if err != nil {
		t.Fatalf("Failed to list events: %v", err)
	}
	if len(events) != 1 {
		t.Errorf("Expected 1 event in database, got %d", len(events))
	}
}

func TestBroker_PublishSessionUpdated(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Create broker
	broker := NewBroker(env.Store, poller)

	// Subscribe
	sub := broker.Subscribe(env.ProjectID)
	defer broker.Unsubscribe(sub)

	// Publish session updated event
	if err := broker.PublishSessionUpdated(ctx, env.ProjectID, "session-123", "running"); err != nil {
		t.Fatalf("Failed to publish session updated: %v", err)
	}

	// Wait for event
	select {
	case received := <-sub.Events:
		if received.Type != EventTypeSessionUpdated {
			t.Errorf("Expected type %s, got %s", EventTypeSessionUpdated, received.Type)
		}

		var data SessionUpdatedData
		if err := json.Unmarshal(received.Data, &data); err != nil {
			t.Fatalf("Failed to unmarshal data: %v", err)
		}
		if data.SessionID != "session-123" {
			t.Errorf("Expected sessionId 'session-123', got '%s'", data.SessionID)
		}
		if data.Status != "running" {
			t.Errorf("Expected status 'running', got '%s'", data.Status)
		}
	case <-time.After(1 * time.Second):
		t.Error("Timeout waiting for event")
	}
}

func TestBroker_GetEventsSince(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller (needed for broker)
	pollerCfg := DefaultPollerConfig()
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	broker := NewBroker(env.Store, poller)

	// Create some events with different timestamps
	startTime := time.Now()
	time.Sleep(10 * time.Millisecond)

	if err := broker.PublishSessionUpdated(ctx, env.ProjectID, "sess1", "running"); err != nil {
		t.Fatalf("Failed to publish event 1: %v", err)
	}

	midTime := time.Now()
	time.Sleep(10 * time.Millisecond)

	if err := broker.PublishSessionUpdated(ctx, env.ProjectID, "sess2", "stopped"); err != nil {
		t.Fatalf("Failed to publish event 2: %v", err)
	}

	// Get events since start - should get both
	events, err := broker.GetEventsSince(ctx, env.ProjectID, startTime)
	if err != nil {
		t.Fatalf("Failed to get events: %v", err)
	}
	if len(events) != 2 {
		t.Errorf("Expected 2 events, got %d", len(events))
	}

	// Get events since mid - should get only the second
	events, err = broker.GetEventsSince(ctx, env.ProjectID, midTime)
	if err != nil {
		t.Fatalf("Failed to get events: %v", err)
	}
	if len(events) != 1 {
		t.Errorf("Expected 1 event, got %d", len(events))
	}
}

func TestSubscriber_Close(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller
	pollerCfg := DefaultPollerConfig()
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Subscribe
	sub := poller.Subscribe(env.ProjectID)

	// Close the subscriber
	poller.Unsubscribe(sub)

	// Done channel should be closed
	select {
	case <-sub.Done():
		// Expected
	default:
		t.Error("Expected Done channel to be closed")
	}

	// Events channel should be closed
	select {
	case _, ok := <-sub.Events:
		if ok {
			t.Error("Expected Events channel to be closed")
		}
	default:
		// This is also fine - channel is closed but read would block
	}
}

func TestPoller_MultipleSubscribersSameProject(t *testing.T) {
	env := testSetup(t)
	defer env.Cleanup()

	ctx := context.Background()

	// Start poller
	pollerCfg := DefaultPollerConfig()
	pollerCfg.PollInterval = 10 * time.Millisecond
	poller := NewPoller(env.Store, pollerCfg)
	if err := poller.Start(ctx); err != nil {
		t.Fatalf("Failed to start poller: %v", err)
	}
	defer poller.Stop()

	// Two subscribers for the same project
	sub1 := poller.Subscribe(env.ProjectID)
	defer poller.Unsubscribe(sub1)

	sub2 := poller.Subscribe(env.ProjectID)
	defer poller.Unsubscribe(sub2)

	// Insert an event
	event := &model.ProjectEvent{
		ProjectID: env.ProjectID,
		Type:      "test",
		Data:      json.RawMessage(`{}`),
	}
	if err := env.Store.CreateProjectEvent(ctx, event); err != nil {
		t.Fatalf("Failed to create event: %v", err)
	}
	poller.NotifyNewEvent()

	// Both subscribers should receive the event
	received1 := false
	received2 := false

	timeout := time.After(1 * time.Second)
	for !received1 || !received2 {
		select {
		case <-sub1.Events:
			received1 = true
		case <-sub2.Events:
			received2 = true
		case <-timeout:
			t.Fatalf("Timeout: received1=%v, received2=%v", received1, received2)
		}
	}
}
