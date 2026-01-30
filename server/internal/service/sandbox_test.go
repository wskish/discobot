package service

import (
	"context"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/mock"
	"github.com/obot-platform/discobot/server/internal/store"
)

// Use the config constant for test consistency
var testImage = config.DefaultSandboxImage

// setupTestStore creates an in-memory SQLite database for testing
func setupTestStore(t *testing.T) *store.Store {
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

// createTestSession creates a session with the given workspace path for testing
func createTestSession(t *testing.T, s *store.Store, sessionID, workspacePath string) {
	t.Helper()

	ctx := context.Background()

	// Create a workspace first
	workspace := &model.Workspace{
		ID:         "test-workspace",
		ProjectID:  "test-project",
		Path:       workspacePath,
		SourceType: "local",
		Status:     "ready",
	}
	if err := s.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatalf("failed to create test workspace: %v", err)
	}

	// Create the session with workspace path set
	session := &model.Session{
		ID:            sessionID,
		ProjectID:     "test-project",
		WorkspaceID:   "test-workspace",
		Name:          "Test Session",
		Status:        model.SessionStatusReady,
		WorkspacePath: &workspacePath,
	}
	if err := s.CreateSession(ctx, session); err != nil {
		t.Fatalf("failed to create test session: %v", err)
	}
}

func TestSandboxService_CreateForSession(t *testing.T) {
	mockProvider := mock.NewProviderWithImage(testImage)
	testStore := setupTestStore(t)
	cfg := &config.Config{
		SandboxIdleTimeout: 30 * time.Minute,
	}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/home/user/workspace"

	// Create test session with workspace path
	createTestSession(t, testStore, sessionID, workspacePath)

	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Verify sandbox was created and started
	sb, err := mockProvider.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if sb.Status != sandbox.StatusRunning {
		t.Errorf("Expected status %s, got %s", sandbox.StatusRunning, sb.Status)
	}

	if sb.Image != testImage {
		t.Errorf("Expected image %s, got %s", testImage, sb.Image)
	}
}

func TestSandboxService_CreateForSession_AlreadyExists(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create first time
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("First CreateForSession failed: %v", err)
	}

	// Try to create again - should fail
	err = svc.CreateForSession(ctx, sessionID)
	if err == nil {
		t.Error("Expected error when creating duplicate sandbox")
	}
}

func TestSandboxService_GetForSession(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create sandbox
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Get sandbox
	sb, err := svc.GetForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetForSession failed: %v", err)
	}

	if sb.SessionID != sessionID {
		t.Errorf("Expected sessionID %s, got %s", sessionID, sb.SessionID)
	}
}

func TestSandboxService_GetForSession_NotFound(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()

	_, err := svc.GetForSession(ctx, "nonexistent")
	if err != sandbox.ErrNotFound {
		t.Errorf("Expected ErrNotFound, got %v", err)
	}
}

func TestSandboxService_EnsureRunning_CreatesNew(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// EnsureRunning should create if not exists
	err := svc.EnsureRunning(ctx, sessionID)
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}

	sb, err := mockProvider.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if sb.Status != sandbox.StatusRunning {
		t.Errorf("Expected status %s, got %s", sandbox.StatusRunning, sb.Status)
	}
}

func TestSandboxService_EnsureRunning_AlreadyRunning(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create and start
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// EnsureRunning on already running sandbox should succeed
	err = svc.EnsureRunning(ctx, sessionID)
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}
}

func TestSandboxService_EnsureRunning_StartsStopped(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create and start
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Stop the sandbox
	err = svc.StopForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("StopForSession failed: %v", err)
	}

	// EnsureRunning should restart it
	err = svc.EnsureRunning(ctx, sessionID)
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}

	sb, err := mockProvider.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if sb.Status != sandbox.StatusRunning {
		t.Errorf("Expected status %s, got %s", sandbox.StatusRunning, sb.Status)
	}
}

func TestSandboxService_DestroyForSession(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create sandbox
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Destroy sandbox
	err = svc.DestroyForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("DestroyForSession failed: %v", err)
	}

	// Verify sandbox is gone
	_, err = mockProvider.Get(ctx, sessionID)
	if err != sandbox.ErrNotFound {
		t.Errorf("Expected ErrNotFound after destroy, got %v", err)
	}
}

func TestSandboxService_DestroyForSession_NotFound(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()

	// Destroy nonexistent sandbox should not error (idempotent)
	err := svc.DestroyForSession(ctx, "nonexistent")
	if err != nil {
		t.Errorf("DestroyForSession should be idempotent, got: %v", err)
	}
}

func TestSandboxService_Exec(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create sandbox
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Execute command
	result, err := svc.Exec(ctx, sessionID, []string{"echo", "hello"}, sandbox.ExecOptions{})
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}
}

func TestSandboxService_Attach(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/workspace"

	// Create test session
	createTestSession(t, testStore, sessionID, workspacePath)

	// Create sandbox
	err := svc.CreateForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Attach PTY
	pty, err := svc.Attach(ctx, sessionID, 24, 80, "")
	if err != nil {
		t.Fatalf("Attach failed: %v", err)
	}
	defer pty.Close()

	// Write to PTY
	_, err = pty.Write([]byte("test"))
	if err != nil {
		t.Errorf("Write failed: %v", err)
	}

	// Read from PTY
	buf := make([]byte, 1024)
	n, err := pty.Read(buf)
	if err != nil {
		t.Errorf("Read failed: %v", err)
	}
	if n == 0 {
		t.Error("Expected some output from PTY")
	}
}

func TestSandboxService_CreateForSession_NoWorkspacePath(t *testing.T) {
	mockProvider := mock.NewProvider()
	testStore := setupTestStore(t)
	cfg := &config.Config{}
	svc := NewSandboxService(testStore, mockProvider, cfg)

	ctx := context.Background()
	sessionID := "test-session-no-path"

	// Create workspace without setting workspace path on session
	workspace := &model.Workspace{
		ID:         "test-workspace-2",
		ProjectID:  "test-project",
		Path:       "/some/path",
		SourceType: "local",
		Status:     "ready",
	}
	if err := testStore.CreateWorkspace(ctx, workspace); err != nil {
		t.Fatalf("failed to create test workspace: %v", err)
	}

	// Create session WITHOUT workspace path (simulating a session that hasn't been initialized)
	session := &model.Session{
		ID:          sessionID,
		ProjectID:   "test-project",
		WorkspaceID: "test-workspace-2",
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
		// WorkspacePath is nil - not set
	}
	if err := testStore.CreateSession(ctx, session); err != nil {
		t.Fatalf("failed to create test session: %v", err)
	}

	// CreateForSession should fail because workspace path is not set
	err := svc.CreateForSession(ctx, sessionID)
	if err == nil {
		t.Error("Expected error when session has no workspace path")
	}
}
