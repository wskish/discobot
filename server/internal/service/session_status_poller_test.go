package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/events"
	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/sandboxapi"
	"github.com/obot-platform/discobot/server/internal/store"
)

// setupTestStore creates an in-memory SQLite database for testing
func setupTestStoreForPoller(t *testing.T) *store.Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}

	// Run migrations
	if err := db.AutoMigrate(model.AllModels()...); err != nil {
		t.Fatalf("failed to migrate test database: %v", err)
	}

	return store.New(db)
}

// TestSessionStatusPoller_NoImmediateCheck verifies that the poller waits
// for the poll interval before checking, preventing the race condition where
// it checks before the agent API has started the completion.
func TestSessionStatusPoller_NoImmediateCheck(t *testing.T) {
	ctx := context.Background()
	testStore := setupTestStoreForPoller(t)
	logger := slog.Default()

	// Track when status checks happen
	var checkCount atomic.Int32

	// Create mock agent API that tracks when /chat/status is called
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/status" {
			checkCount.Add(1)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(sandboxapi.ChatStatusResponse{
				IsRunning:    false,
				CompletionID: nil,
			})
			return
		}
		http.NotFound(w, r)
	})

	mockProvider := &mockSandboxProvider{
		secret:  "test-secret",
		handler: handler,
	}

	cfg := &config.Config{}
	eventPoller := events.NewPoller(testStore, events.DefaultPollerConfig())
	eventBroker := events.NewBroker(testStore, eventPoller)

	sandboxSvc := NewSandboxService(testStore, mockProvider, cfg, nil, eventBroker, nil)

	// Create poller with very short intervals for testing
	poller := &SessionStatusPoller{
		store:       testStore,
		sandboxSvc:  sandboxSvc,
		eventBroker: eventBroker,
		logger:      logger.With("component", "test_poller"),
		kickChan:    make(chan struct{}, 1),
		stopChan:    make(chan struct{}),
	}

	// Create a test session marked as running
	project := &model.Project{ID: "test-project", Name: "Test"}
	workspace := &model.Workspace{
		ID:          "test-ws",
		ProjectID:   project.ID,
		Path:        "/test",
		SourceType:  "local",
		DisplayName: func() *string { s := "Test WS"; return &s }(),
	}
	session := &model.Session{
		ID:          "test-session",
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		Status:      model.SessionStatusRunning,
	}

	if err := testStore.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}

	// Create sandbox for this session
	if _, err := mockProvider.Create(ctx, session.ID, sandbox.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// Start the poller
	pollerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	poller.Start(pollerCtx)
	defer poller.Shutdown(ctx)

	// Kick the poller
	poller.Kick()

	// Wait a short time (less than poll interval)
	time.Sleep(100 * time.Millisecond)

	// Verify no checks happened immediately
	if got := checkCount.Load(); got != 0 {
		t.Errorf("Poller checked immediately after kick, want 0 checks, got %d", got)
	}

	// Note: We don't wait for the full poll interval here since that would
	// make the test slow. The key assertion is that NO immediate check happens.
}

// TestSessionStatusPoller_MarksStaleSessions verifies that the poller
// correctly identifies and marks sessions that are "running" in the database
// but not actually running in the agent API.
func TestSessionStatusPoller_MarksStaleSessions(t *testing.T) {
	ctx := context.Background()
	testStore := setupTestStoreForPoller(t)
	logger := slog.Default()

	// Create mock agent API that returns isRunning: false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/status" {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(sandboxapi.ChatStatusResponse{
				IsRunning:    false,
				CompletionID: nil,
			})
			return
		}
		http.NotFound(w, r)
	})

	mockProvider := &mockSandboxProvider{
		secret:  "test-secret",
		handler: handler,
	}

	cfg := &config.Config{}
	eventPoller := events.NewPoller(testStore, events.DefaultPollerConfig())
	eventBroker := events.NewBroker(testStore, eventPoller)

	sandboxSvc := NewSandboxService(testStore, mockProvider, cfg, nil, eventBroker, nil)
	poller := NewSessionStatusPoller(testStore, sandboxSvc, eventBroker, logger)

	// Create a test session marked as running
	project := &model.Project{ID: "test-project", Name: "Test"}
	workspace := &model.Workspace{
		ID:          "test-ws",
		ProjectID:   project.ID,
		Path:        "/test",
		SourceType:  "local",
		DisplayName: func() *string { s := "Test WS"; return &s }(),
	}
	session := &model.Session{
		ID:          "test-session",
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		Status:      model.SessionStatusRunning,
	}

	if err := testStore.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}

	// Create sandbox for this session
	if _, err := mockProvider.Create(ctx, session.ID, sandbox.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// Manually check sessions (simulating what happens after poll interval)
	hasRunning, err := poller.checkRunningSessions(ctx)
	if err != nil {
		t.Fatalf("checkRunningSessions failed: %v", err)
	}

	// Should have found the session but marked it as not running
	if hasRunning {
		t.Error("Expected hasRunning=false after marking stale session")
	}

	// Verify session was marked as ready
	updatedSession, err := testStore.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}

	if updatedSession.Status != model.SessionStatusReady {
		t.Errorf("Expected session status to be %q, got %q", model.SessionStatusReady, updatedSession.Status)
	}
}

// TestSessionStatusPoller_RaceCondition_AgentNotStarted simulates the race
// condition where the poller is kicked but the agent API hasn't received the
// completion request yet.
func TestSessionStatusPoller_RaceCondition_AgentNotStarted(t *testing.T) {
	ctx := context.Background()
	testStore := setupTestStoreForPoller(t)
	logger := slog.Default()

	// Simulate agent API that hasn't started completion yet
	var agentStarted atomic.Bool
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/status" {
			w.Header().Set("Content-Type", "application/json")
			// Return isRunning based on whether agent has started
			json.NewEncoder(w).Encode(sandboxapi.ChatStatusResponse{
				IsRunning:    agentStarted.Load(),
				CompletionID: func() *string { s := "test-completion"; return &s }(),
			})
			return
		}
		http.NotFound(w, r)
	})

	mockProvider := &mockSandboxProvider{
		secret:  "test-secret",
		handler: handler,
	}

	cfg := &config.Config{}
	eventPoller := events.NewPoller(testStore, events.DefaultPollerConfig())
	eventBroker := events.NewBroker(testStore, eventPoller)

	sandboxSvc := NewSandboxService(testStore, mockProvider, cfg, nil, eventBroker, nil)
	poller := NewSessionStatusPoller(testStore, sandboxSvc, eventBroker, logger)

	// Create a test session marked as running
	project := &model.Project{ID: "test-project", Name: "Test"}
	workspace := &model.Workspace{
		ID:          "test-ws",
		ProjectID:   project.ID,
		Path:        "/test",
		SourceType:  "local",
		DisplayName: func() *string { s := "Test WS"; return &s }(),
	}
	session := &model.Session{
		ID:          "test-session",
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		Status:      model.SessionStatusRunning,
	}

	if err := testStore.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateSession(ctx, session); err != nil {
		t.Fatal(err)
	}

	// Create sandbox for this session
	if _, err := mockProvider.Create(ctx, session.ID, sandbox.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// Check while agent hasn't started - this simulates the immediate check issue
	hasRunning, err := poller.checkRunningSessions(ctx)
	if err != nil {
		t.Fatalf("checkRunningSessions failed: %v", err)
	}

	// Session should have been marked as ready (incorrectly)
	if hasRunning {
		t.Error("Expected hasRunning=false when agent hasn't started")
	}

	updatedSession, err := testStore.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}

	// This demonstrates the bug: session marked ready even though completion about to start
	if updatedSession.Status != model.SessionStatusReady {
		t.Errorf("Session should have been incorrectly marked as ready (demonstrating the race condition), got %q", updatedSession.Status)
	}

	// Now simulate agent starting
	agentStarted.Store(true)

	// Reset session to running
	if err := testStore.UpdateSessionStatus(ctx, session.ID, model.SessionStatusRunning, nil); err != nil {
		t.Fatal(err)
	}

	// Check again - now agent is running
	hasRunning, err = poller.checkRunningSessions(ctx)
	if err != nil {
		t.Fatalf("checkRunningSessions failed: %v", err)
	}

	// Should stay running since agent reports it's running
	if !hasRunning {
		t.Error("Expected hasRunning=true when agent is running")
	}

	finalSession, err := testStore.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}

	if finalSession.Status != model.SessionStatusRunning {
		t.Errorf("Expected session to stay running, got %q", finalSession.Status)
	}
}

// TestSessionStatusPoller_MultipleSessionsAfterChatFinishes simulates
// multiple sessions where one finishes and kicks the poller to check others.
func TestSessionStatusPoller_MultipleSessionsAfterChatFinishes(t *testing.T) {
	ctx := context.Background()
	testStore := setupTestStoreForPoller(t)
	logger := slog.Default()

	// Create mock agent API with per-session state
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat/status" {
			// Extract session ID from somewhere - in reality this comes from the sandbox routing
			// For this test, we'll use a simple approach
			w.Header().Set("Content-Type", "application/json")
			// Default to not running if we can't determine session
			json.NewEncoder(w).Encode(sandboxapi.ChatStatusResponse{
				IsRunning:    false,
				CompletionID: nil,
			})
			return
		}
		http.NotFound(w, r)
	})

	mockProvider := &mockSandboxProvider{
		secret:  "test-secret",
		handler: handler,
	}

	cfg := &config.Config{}
	eventPoller := events.NewPoller(testStore, events.DefaultPollerConfig())
	eventBroker := events.NewBroker(testStore, eventPoller)

	sandboxSvc := NewSandboxService(testStore, mockProvider, cfg, nil, eventBroker, nil)
	poller := NewSessionStatusPoller(testStore, sandboxSvc, eventBroker, logger)

	// Create test project and workspace
	project := &model.Project{ID: "test-project", Name: "Test"}
	workspace := &model.Workspace{
		ID:          "test-ws",
		ProjectID:   project.ID,
		Path:        "/test",
		SourceType:  "local",
		DisplayName: func() *string { s := "Test WS"; return &s }(),
	}

	if err := testStore.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	if err := testStore.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatal(err)
	}

	// Create multiple sessions marked as running
	for i := 1; i <= 2; i++ {
		sessionID := "session-" + string(rune('0'+i))
		session := &model.Session{
			ID:          sessionID,
			ProjectID:   project.ID,
			WorkspaceID: workspace.ID,
			Status:      model.SessionStatusRunning,
		}

		if err := testStore.CreateSession(ctx, session); err != nil {
			t.Fatal(err)
		}

		// Create sandbox for each session
		if _, err := mockProvider.Create(ctx, session.ID, sandbox.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	// Check all running sessions
	hasRunning, err := poller.checkRunningSessions(ctx)
	if err != nil {
		t.Fatalf("checkRunningSessions failed: %v", err)
	}

	// Should have marked both as not running (since our mock returns false)
	if hasRunning {
		t.Error("Expected hasRunning=false after checking all sessions")
	}

	// Verify both sessions were marked as ready
	for i := 1; i <= 2; i++ {
		sessionID := "session-" + string(rune('0'+i))
		updatedSession, err := testStore.GetSessionByID(ctx, sessionID)
		if err != nil {
			t.Fatal(err)
		}

		if updatedSession.Status != model.SessionStatusReady {
			t.Errorf("Session %s: expected status %q, got %q",
				sessionID, model.SessionStatusReady, updatedSession.Status)
		}
	}
}
