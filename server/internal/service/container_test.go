package service

import (
	"context"
	"testing"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/container/mock"
)

// Use the config constant for test consistency
var testImage = config.DefaultContainerImage

func TestContainerService_CreateForSession(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{
		ContainerImage:       testImage,
		ContainerIdleTimeout: 30 * time.Minute,
	}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/home/user/workspace"

	err := svc.CreateForSession(ctx, sessionID, workspacePath)
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Verify container was created and started
	c, err := mockRuntime.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if c.Status != container.StatusRunning {
		t.Errorf("Expected status %s, got %s", container.StatusRunning, c.Status)
	}

	if c.Image != testImage {
		t.Errorf("Expected image %s, got %s", testImage, c.Image)
	}
}

func TestContainerService_CreateForSession_AlreadyExists(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create first time
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("First CreateForSession failed: %v", err)
	}

	// Try to create again - should fail
	err = svc.CreateForSession(ctx, sessionID, "/workspace")
	if err == nil {
		t.Error("Expected error when creating duplicate container")
	}
}

func TestContainerService_GetForSession(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create container
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Get container
	c, err := svc.GetForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetForSession failed: %v", err)
	}

	if c.SessionID != sessionID {
		t.Errorf("Expected sessionID %s, got %s", sessionID, c.SessionID)
	}
}

func TestContainerService_GetForSession_NotFound(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()

	_, err := svc.GetForSession(ctx, "nonexistent")
	if err != container.ErrNotFound {
		t.Errorf("Expected ErrNotFound, got %v", err)
	}
}

func TestContainerService_EnsureRunning_CreatesNew(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// EnsureRunning should create if not exists
	err := svc.EnsureRunning(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}

	c, err := mockRuntime.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if c.Status != container.StatusRunning {
		t.Errorf("Expected status %s, got %s", container.StatusRunning, c.Status)
	}
}

func TestContainerService_EnsureRunning_AlreadyRunning(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create and start
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// EnsureRunning on already running container should succeed
	err = svc.EnsureRunning(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}
}

func TestContainerService_EnsureRunning_StartsStopped(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create and start
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Stop the container
	err = svc.StopForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("StopForSession failed: %v", err)
	}

	// EnsureRunning should restart it
	err = svc.EnsureRunning(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("EnsureRunning failed: %v", err)
	}

	c, err := mockRuntime.Get(ctx, sessionID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	if c.Status != container.StatusRunning {
		t.Errorf("Expected status %s, got %s", container.StatusRunning, c.Status)
	}
}

func TestContainerService_DestroyForSession(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create container
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Destroy container
	err = svc.DestroyForSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("DestroyForSession failed: %v", err)
	}

	// Verify container is gone
	_, err = mockRuntime.Get(ctx, sessionID)
	if err != container.ErrNotFound {
		t.Errorf("Expected ErrNotFound after destroy, got %v", err)
	}
}

func TestContainerService_DestroyForSession_NotFound(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()

	// Destroy nonexistent container should not error (idempotent)
	err := svc.DestroyForSession(ctx, "nonexistent")
	if err != nil {
		t.Errorf("DestroyForSession should be idempotent, got: %v", err)
	}
}

func TestContainerService_Exec(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create container
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Execute command
	result, err := svc.Exec(ctx, sessionID, []string{"echo", "hello"}, container.ExecOptions{})
	if err != nil {
		t.Fatalf("Exec failed: %v", err)
	}

	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}
}

func TestContainerService_Attach(t *testing.T) {
	mockRuntime := mock.NewProvider()
	cfg := &config.Config{ContainerImage: testImage}
	svc := NewContainerService(nil, mockRuntime, cfg)

	ctx := context.Background()
	sessionID := "test-session-1"

	// Create container
	err := svc.CreateForSession(ctx, sessionID, "/workspace")
	if err != nil {
		t.Fatalf("CreateForSession failed: %v", err)
	}

	// Attach PTY
	pty, err := svc.Attach(ctx, sessionID, 24, 80)
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
