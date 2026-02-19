package service

import (
	"context"
	"fmt"
	"testing"

	"github.com/obot-platform/discobot/server/internal/jobs"
	"github.com/obot-platform/discobot/server/internal/model"
)

// TestCommitSession_Success tests that CommitSession enqueues a job with the correct payload.
func TestCommitSession_Success(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	var enqueuedJob jobs.JobPayload
	mockEnqueuer := &mockJobEnqueuer{
		enqueueFunc: func(_ context.Context, payload jobs.JobPayload) error {
			enqueuedJob = payload
			return nil
		},
	}

	sessionSvc := NewSessionService(env.store, env.gitService, env.mockSandbox, nil, env.eventBroker, mockEnqueuer)

	err := sessionSvc.CommitSession(context.Background(), project.ID, session.ID, mockEnqueuer)
	if err != nil {
		t.Fatalf("CommitSession failed: %v", err)
	}

	if enqueuedJob == nil {
		t.Fatal("Expected job to be enqueued")
	}
	commitPayload, ok := enqueuedJob.(jobs.SessionCommitPayload)
	if !ok {
		t.Fatalf("Expected SessionCommitPayload, got %T", enqueuedJob)
	}
	if commitPayload.WorkspaceID != workspace.ID {
		t.Errorf("Expected workspace ID %s, got %s", workspace.ID, commitPayload.WorkspaceID)
	}
	if commitPayload.SessionID != session.ID {
		t.Errorf("Expected session ID %s, got %s", session.ID, commitPayload.SessionID)
	}
}

// TestCommitSession_EnqueueFailure tests that CommitSession returns an error when enqueue fails.
func TestCommitSession_EnqueueFailure(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	mockEnqueuer := &mockJobEnqueuer{
		enqueueFunc: func(_ context.Context, _ jobs.JobPayload) error {
			return fmt.Errorf("simulated enqueue error")
		},
	}

	sessionSvc := NewSessionService(env.store, env.gitService, env.mockSandbox, nil, env.eventBroker, mockEnqueuer)

	err := sessionSvc.CommitSession(context.Background(), project.ID, session.ID, mockEnqueuer)
	if err == nil {
		t.Fatal("Expected CommitSession to fail when enqueue fails")
	}
}

// TestSessionCommitPayload_ResourceKey tests that SessionCommitPayload returns workspace resource.
func TestSessionCommitPayload_ResourceKey(t *testing.T) {
	payload := jobs.SessionCommitPayload{
		ProjectID:   "test-project",
		SessionID:   "test-session",
		WorkspaceID: "test-workspace",
	}

	resourceType, resourceID := payload.ResourceKey()

	if resourceType != jobs.ResourceTypeWorkspace {
		t.Errorf("Expected resource type %s, got %s", jobs.ResourceTypeWorkspace, resourceType)
	}
	if resourceID != "test-workspace" {
		t.Errorf("Expected resource ID test-workspace, got %s", resourceID)
	}
}

// TestSessionCommitPayload_AllowDuplicates tests that SessionCommitPayload allows duplicate jobs.
func TestSessionCommitPayload_AllowDuplicates(t *testing.T) {
	payload := jobs.SessionCommitPayload{
		ProjectID:   "test-project",
		SessionID:   "test-session",
		WorkspaceID: "test-workspace",
	}

	if !payload.AllowDuplicates() {
		t.Error("Expected SessionCommitPayload.AllowDuplicates() to return true")
	}
}

// TestUpdateStatus_ClearsCommitStatusOnRunning tests that when a session transitions to "running"
// and its commit status is "completed", the commit status is cleared back to none.
func TestUpdateStatus_ClearsCommitStatusOnRunning(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with completed commit status
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)
	session.CommitStatus = model.CommitStatusCompleted
	session.AppliedCommit = ptrString("abc123")
	if err := env.store.UpdateSession(context.Background(), session); err != nil {
		t.Fatalf("Failed to update session: %v", err)
	}

	sessionSvc := NewSessionService(env.store, env.gitService, env.mockSandbox, nil, env.eventBroker, nil)

	// Transition session to running
	_, err := sessionSvc.UpdateStatus(context.Background(), project.ID, session.ID, model.SessionStatusRunning, nil)
	if err != nil {
		t.Fatalf("UpdateStatus failed: %v", err)
	}

	// Verify commit status was cleared
	sess, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if sess.CommitStatus != model.CommitStatusNone {
		t.Errorf("Expected commit status to be cleared to none, got %s", sess.CommitStatus)
	}

	// Verify the applied commit is still preserved
	if sess.AppliedCommit == nil || *sess.AppliedCommit != "abc123" {
		t.Errorf("Expected applied commit to be preserved as 'abc123', got %v", sess.AppliedCommit)
	}
}

// TestUpdateStatus_DoesNotClearCommitStatusWhenNotCompleted tests that commit status is
// only cleared when it is "completed", not for other commit statuses.
func TestUpdateStatus_DoesNotClearCommitStatusWhenNotCompleted(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with no commit status
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)
	session.CommitStatus = model.CommitStatusNone
	if err := env.store.UpdateSession(context.Background(), session); err != nil {
		t.Fatalf("Failed to update session: %v", err)
	}

	sessionSvc := NewSessionService(env.store, env.gitService, env.mockSandbox, nil, env.eventBroker, nil)

	// Transition session to running
	_, err := sessionSvc.UpdateStatus(context.Background(), project.ID, session.ID, model.SessionStatusRunning, nil)
	if err != nil {
		t.Fatalf("UpdateStatus failed: %v", err)
	}

	// Verify commit status remains none (unchanged)
	sess, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if sess.CommitStatus != model.CommitStatusNone {
		t.Errorf("Expected commit status to remain none, got %s", sess.CommitStatus)
	}
}

// mockJobEnqueuer is a mock implementation of JobEnqueuer for testing.
type mockJobEnqueuer struct {
	enqueueFunc func(ctx context.Context, payload jobs.JobPayload) error
}

func (m *mockJobEnqueuer) Enqueue(ctx context.Context, payload jobs.JobPayload) error {
	if m.enqueueFunc != nil {
		return m.enqueueFunc(ctx, payload)
	}
	return nil
}
