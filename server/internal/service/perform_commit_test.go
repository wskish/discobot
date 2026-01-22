package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/obot-platform/octobot/server/internal/config"
	"github.com/obot-platform/octobot/server/internal/database"
	"github.com/obot-platform/octobot/server/internal/events"
	"github.com/obot-platform/octobot/server/internal/git"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/sandbox/mock"
	"github.com/obot-platform/octobot/server/internal/sandbox/sandboxapi"
	"github.com/obot-platform/octobot/server/internal/store"
)

// testEnv holds the test environment for PerformCommit tests.
type testEnv struct {
	store        *store.Store
	gitService   *GitService
	mockSandbox  *mock.Provider
	eventBroker  *events.Broker
	workspaceDir string
	cleanup      func()
}

// newTestEnv creates a test environment with an in-memory database and git workspace.
func newTestEnv(t *testing.T) *testEnv {
	t.Helper()

	// Create temp directory for workspaces
	workspaceDir := t.TempDir()

	// Create SQLite database
	dbPath := filepath.Join(t.TempDir(), "test.db")
	dsn := fmt.Sprintf("sqlite3://%s", dbPath)

	cfg := &config.Config{
		DatabaseDSN:    dsn,
		DatabaseDriver: "sqlite",
	}

	db, err := database.New(cfg)
	if err != nil {
		t.Fatalf("Failed to create database: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("Failed to run migrations: %v", err)
	}

	s := store.New(db.DB)

	// Create git provider
	workspaceSource := git.NewStoreWorkspaceSource(s)
	gitProvider, err := git.NewLocalProvider(workspaceDir, git.WithWorkspaceSource(workspaceSource))
	if err != nil {
		t.Fatalf("Failed to create git provider: %v", err)
	}

	gitSvc := NewGitService(s, gitProvider)

	// Create mock sandbox
	mockSandbox := mock.NewProvider()

	// Create event broker (minimal setup)
	eventPoller := events.NewPoller(s, events.DefaultPollerConfig())
	eventBroker := events.NewBroker(s, eventPoller)

	return &testEnv{
		store:        s,
		gitService:   gitSvc,
		mockSandbox:  mockSandbox,
		eventBroker:  eventBroker,
		workspaceDir: workspaceDir,
		cleanup: func() {
			_ = db.Close()
		},
	}
}

// createTestProject creates a test project.
func (e *testEnv) createTestProject(t *testing.T) *model.Project {
	t.Helper()
	project := &model.Project{
		ID:   "test-project",
		Name: "Test Project",
	}
	if err := e.store.CreateProject(context.Background(), project); err != nil {
		t.Fatalf("Failed to create project: %v", err)
	}
	return project
}

// createTestAgent creates a test agent.
func (e *testEnv) createTestAgent(t *testing.T, projectID string) *model.Agent {
	t.Helper()
	agent := &model.Agent{
		ID:        "test-agent",
		ProjectID: projectID,
		Name:      "Test Agent",
		AgentType: "claude-code",
	}
	if err := e.store.CreateAgent(context.Background(), agent); err != nil {
		t.Fatalf("Failed to create agent: %v", err)
	}
	return agent
}

// createTestWorkspace creates a test workspace with a git repo.
func (e *testEnv) createTestWorkspace(t *testing.T, projectID string) (*model.Workspace, string) {
	t.Helper()

	// Create workspace directory with git repo
	wsPath := filepath.Join(e.workspaceDir, "test-workspace")
	if err := os.MkdirAll(wsPath, 0755); err != nil {
		t.Fatalf("Failed to create workspace dir: %v", err)
	}

	// Initialize git repo
	runGit(t, wsPath, "init")
	runGit(t, wsPath, "config", "user.email", "test@example.com")
	runGit(t, wsPath, "config", "user.name", "Test User")

	// Create initial commit
	readme := filepath.Join(wsPath, "README.md")
	if err := os.WriteFile(readme, []byte("# Test\n"), 0644); err != nil {
		t.Fatalf("Failed to write file: %v", err)
	}
	runGit(t, wsPath, "add", ".")
	runGit(t, wsPath, "commit", "-m", "Initial commit")

	// Get commit hash
	commit := strings.TrimSpace(runGit(t, wsPath, "rev-parse", "HEAD"))

	workspace := &model.Workspace{
		ID:         "test-workspace",
		ProjectID:  projectID,
		Path:       wsPath,
		SourceType: "local",
		Status:     model.WorkspaceStatusReady,
		Commit:     ptrString(commit),
	}
	if err := e.store.CreateWorkspace(context.Background(), workspace); err != nil {
		t.Fatalf("Failed to create workspace: %v", err)
	}

	return workspace, commit
}

// createTestSession creates a test session.
func (e *testEnv) createTestSession(t *testing.T, projectID, workspaceID, agentID, baseCommit string) *model.Session {
	t.Helper()
	session := &model.Session{
		ID:           "test-session",
		ProjectID:    projectID,
		WorkspaceID:  workspaceID,
		AgentID:      ptrString(agentID),
		Name:         "Test Session",
		Status:       model.SessionStatusReady,
		CommitStatus: model.CommitStatusPending,
		BaseCommit:   ptrString(baseCommit),
	}
	if err := e.store.CreateSession(context.Background(), session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}
	return session
}

// addCommitToWorkspace adds a new commit to the workspace.
func (e *testEnv) addCommitToWorkspace(t *testing.T, wsPath, filename, content string) string {
	t.Helper()
	filePath := filepath.Join(wsPath, filename)
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		t.Fatalf("Failed to write file: %v", err)
	}
	runGit(t, wsPath, "add", ".")
	runGit(t, wsPath, "commit", "-m", "Add "+filename)
	return strings.TrimSpace(runGit(t, wsPath, "rev-parse", "HEAD"))
}

// runGit runs a git command and returns stdout.
func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
	return string(out)
}

// mockHandler tracks requests and returns configured responses.
type mockHandler struct {
	mu              sync.Mutex
	chatRequests    []string
	commitsRequests []string

	// Configurable responses
	commitsResponse *sandboxapi.CommitsResponse
	commitsError    *sandboxapi.CommitsErrorResponse
	commitsHTTPCode int
}

func newMockHandler() *mockHandler {
	return &mockHandler{
		commitsHTTPCode: http.StatusOK,
	}
}

func (h *mockHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()

	switch {
	case r.URL.Path == "/chat" && r.Method == "POST":
		h.chatRequests = append(h.chatRequests, r.URL.String())
		// POST returns 202 Accepted, then client does GET for SSE stream
		w.WriteHeader(http.StatusAccepted)
		return

	case r.URL.Path == "/chat" && r.Method == "GET":
		// GET returns SSE stream
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		// Send done signal immediately
		_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
		return

	case r.URL.Path == "/commits" && r.Method == "GET":
		h.commitsRequests = append(h.commitsRequests, r.URL.String())
		w.Header().Set("Content-Type", "application/json")

		if h.commitsError != nil {
			w.WriteHeader(h.commitsHTTPCode)
			_ = json.NewEncoder(w).Encode(h.commitsError)
			return
		}

		if h.commitsResponse != nil {
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(h.commitsResponse)
			return
		}

		// Default: no commits
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{CommitCount: 0})
		return

	default:
		http.NotFound(w, r)
	}
}

func (h *mockHandler) getChatRequestCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.chatRequests)
}

func (h *mockHandler) getCommitsRequestCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.commitsRequests)
}

// TestPerformCommit_WorkspaceUnchangedNoExistingPatches tests the normal flow when
// workspace commit hasn't changed and the agent doesn't have patches ready yet.
// This tests the fallback path: optimistic check finds nothing -> send prompt -> fetch patches.
func TestPerformCommit_WorkspaceUnchangedNoExistingPatches(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	callCount := 0
	var mu sync.Mutex

	// Set up mock handler - first GetCommits returns no patches, second returns patches
	handler := &trackingHandler{
		onChat: func(w http.ResponseWriter, _ *http.Request) {
			// POST returns 202 Accepted
			w.WriteHeader(http.StatusAccepted)
		},
		onCommits: func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			callCount++
			currentCall := callCount
			mu.Unlock()

			w.Header().Set("Content-Type", "application/json")

			// First call (optimistic check) - return no patches
			// Second call (after prompt) - return patches
			if currentCall == 1 {
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{CommitCount: 0})
			} else {
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{
					Patches: `From abc123 Mon Sep 17 00:00:00 2001
From: Test <test@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: Test commit

---
 test.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/test.txt b/test.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/test.txt
@@ -0,0 +1 @@
+test content
--
`,
					CommitCount: 1,
				})
			}
		},
	}
	env.mockSandbox.HTTPHandler = handler

	// Create sandbox for the session
	_, err := env.mockSandbox.Create(context.Background(), session.ID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create sandbox: %v", err)
	}
	if err := env.mockSandbox.Start(context.Background(), session.ID); err != nil {
		t.Fatalf("Failed to start sandbox: %v", err)
	}

	// Create session service
	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit
	err = sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify: should have called GetCommits twice (optimistic check + after prompt)
	mu.Lock()
	finalCount := callCount
	mu.Unlock()
	if finalCount != 2 {
		t.Errorf("Expected 2 commits requests (optimistic check + fetch), got %d", finalCount)
	}

	// Verify session status
	updatedSession, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if updatedSession.CommitStatus != model.CommitStatusCompleted {
		t.Errorf("Expected commit status %s, got %s", model.CommitStatusCompleted, updatedSession.CommitStatus)
	}
	if updatedSession.AppliedCommit == nil || *updatedSession.AppliedCommit == "" {
		t.Error("Expected appliedCommit to be set")
	}
}

// TestPerformCommit_WorkspaceChangedWithPatches tests the optimistic path when
// workspace commit has changed and agent already has patches available.
func TestPerformCommit_WorkspaceChangedWithPatches(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with the initial commit
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	// Add a new commit to the workspace (simulating external change)
	newCommit := env.addCommitToWorkspace(t, workspace.Path, "external.txt", "external content\n")

	// Update workspace in DB to reflect the new commit
	workspace.Commit = ptrString(newCommit)
	if err := env.store.UpdateWorkspace(context.Background(), workspace); err != nil {
		t.Fatalf("Failed to update workspace: %v", err)
	}

	// Set up mock handler with patches available (simulating agent already has work done)
	handler := newMockHandler()
	handler.commitsResponse = &sandboxapi.CommitsResponse{
		Patches: `From def456 Mon Sep 17 00:00:00 2001
From: Agent <agent@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: Agent work

---
 agent.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/agent.txt b/agent.txt
new file mode 100644
index 0000000..def456
--- /dev/null
+++ b/agent.txt
@@ -0,0 +1 @@
+agent work
--
`,
		CommitCount: 1,
	}
	env.mockSandbox.HTTPHandler = handler

	// Create and start sandbox
	_, err := env.mockSandbox.Create(context.Background(), session.ID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create sandbox: %v", err)
	}
	if err := env.mockSandbox.Start(context.Background(), session.ID); err != nil {
		t.Fatalf("Failed to start sandbox: %v", err)
	}

	// Create session service
	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit
	err = sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify: should NOT have sent /octobot-commit (skipped step 2 due to optimistic path)
	if handler.getChatRequestCount() != 0 {
		t.Errorf("Expected 0 chat requests (optimistic path should skip prompt), got %d", handler.getChatRequestCount())
	}

	// Verify: should have called GetCommits once (during syncBaseCommit)
	if handler.getCommitsRequestCount() != 1 {
		t.Errorf("Expected 1 commits request (optimistic check), got %d", handler.getCommitsRequestCount())
	}

	// Verify session was updated
	updatedSession, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}

	// BaseCommit should be updated to the new commit
	if updatedSession.BaseCommit == nil || *updatedSession.BaseCommit != newCommit {
		t.Errorf("Expected baseCommit to be updated to %s, got %v", newCommit, updatedSession.BaseCommit)
	}

	if updatedSession.CommitStatus != model.CommitStatusCompleted {
		t.Errorf("Expected commit status %s, got %s", model.CommitStatusCompleted, updatedSession.CommitStatus)
	}

	if updatedSession.AppliedCommit == nil || *updatedSession.AppliedCommit == "" {
		t.Error("Expected appliedCommit to be set")
	}
}

// TestPerformCommit_WorkspaceChangedNoPatches tests the fallback path when
// workspace commit has changed but agent has no patches (continues with normal flow).
func TestPerformCommit_WorkspaceChangedNoPatches(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with the initial commit
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	// Add a new commit to the workspace
	newCommit := env.addCommitToWorkspace(t, workspace.Path, "external.txt", "external content\n")

	// Update workspace in DB
	workspace.Commit = ptrString(newCommit)
	if err := env.store.UpdateWorkspace(context.Background(), workspace); err != nil {
		t.Fatalf("Failed to update workspace: %v", err)
	}

	// Track request order
	var requestOrder []string
	var mu sync.Mutex

	// Set up mock handler - first GetCommits returns no patches, second returns patches
	handler := &trackingHandler{
		onChat: func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			requestOrder = append(requestOrder, "chat")
			mu.Unlock()
			// POST returns 202 Accepted
			w.WriteHeader(http.StatusAccepted)
		},
		onCommits: func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			count := len(requestOrder)
			requestOrder = append(requestOrder, "commits")
			mu.Unlock()

			w.Header().Set("Content-Type", "application/json")

			// First call (optimistic check) - return no patches
			// Second call (after prompt) - return patches
			if count == 0 {
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{CommitCount: 0})
			} else {
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{
					Patches: `From abc123 Mon Sep 17 00:00:00 2001
From: Agent <agent@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: Work done

---
 work.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/work.txt b/work.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/work.txt
@@ -0,0 +1 @@
+work
--
`,
					CommitCount: 1,
				})
			}
		},
	}
	env.mockSandbox.HTTPHandler = handler

	// Create and start sandbox
	_, err := env.mockSandbox.Create(context.Background(), session.ID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create sandbox: %v", err)
	}
	if err := env.mockSandbox.Start(context.Background(), session.ID); err != nil {
		t.Fatalf("Failed to start sandbox: %v", err)
	}

	// Create session service
	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit
	err = sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify request order: optimistic commits check -> chat prompt -> fetch commits
	mu.Lock()
	order := requestOrder
	mu.Unlock()

	if len(order) != 3 {
		t.Fatalf("Expected 3 requests, got %d: %v", len(order), order)
	}
	if order[0] != "commits" {
		t.Errorf("Expected first request to be commits (optimistic check), got %s", order[0])
	}
	if order[1] != "chat" {
		t.Errorf("Expected second request to be chat (prompt), got %s", order[1])
	}
	if order[2] != "commits" {
		t.Errorf("Expected third request to be commits (fetch patches), got %s", order[2])
	}

	// Verify session state
	updatedSession, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}

	if updatedSession.BaseCommit == nil || *updatedSession.BaseCommit != newCommit {
		t.Errorf("Expected baseCommit to be %s, got %v", newCommit, updatedSession.BaseCommit)
	}

	if updatedSession.CommitStatus != model.CommitStatusCompleted {
		t.Errorf("Expected commit status %s, got %s", model.CommitStatusCompleted, updatedSession.CommitStatus)
	}
}

// TestPerformCommit_WorkspaceChangedGetCommitsError tests that when optimistic
// check returns an error, we fall back to normal flow.
func TestPerformCommit_WorkspaceChangedGetCommitsError(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with the initial commit
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	// Add a new commit to the workspace
	newCommit := env.addCommitToWorkspace(t, workspace.Path, "external.txt", "external content\n")

	// Update workspace in DB
	workspace.Commit = ptrString(newCommit)
	if err := env.store.UpdateWorkspace(context.Background(), workspace); err != nil {
		t.Fatalf("Failed to update workspace: %v", err)
	}

	callCount := 0
	var mu sync.Mutex

	// Set up mock handler - first GetCommits returns error, second returns patches
	handler := &trackingHandler{
		onChat: func(w http.ResponseWriter, _ *http.Request) {
			// POST returns 202 Accepted
			w.WriteHeader(http.StatusAccepted)
		},
		onCommits: func(w http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			callCount++
			currentCall := callCount
			mu.Unlock()

			w.Header().Set("Content-Type", "application/json")

			// First call returns error, second returns patches
			if currentCall == 1 {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsErrorResponse{
					Error:   "parent_mismatch",
					Message: "Parent commit not found",
				})
			} else {
				_ = json.NewEncoder(w).Encode(sandboxapi.CommitsResponse{
					Patches: `From abc123 Mon Sep 17 00:00:00 2001
From: Agent <agent@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: Work

---
 work.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/work.txt b/work.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/work.txt
@@ -0,0 +1 @@
+work
--
`,
					CommitCount: 1,
				})
			}
		},
	}
	env.mockSandbox.HTTPHandler = handler

	// Create and start sandbox
	_, err := env.mockSandbox.Create(context.Background(), session.ID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create sandbox: %v", err)
	}
	if err := env.mockSandbox.Start(context.Background(), session.ID); err != nil {
		t.Fatalf("Failed to start sandbox: %v", err)
	}

	// Create session service
	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit
	err = sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify GetCommits was called twice (optimistic + after prompt)
	mu.Lock()
	finalCount := callCount
	mu.Unlock()

	if finalCount != 2 {
		t.Errorf("Expected 2 GetCommits calls, got %d", finalCount)
	}

	// Verify session completed
	updatedSession, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}

	if updatedSession.CommitStatus != model.CommitStatusCompleted {
		t.Errorf("Expected commit status %s, got %s", model.CommitStatusCompleted, updatedSession.CommitStatus)
	}
}

// TestPerformCommit_AlreadyCompleted tests idempotency - skips if already completed.
func TestPerformCommit_AlreadyCompleted(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session that's already completed
	session := &model.Session{
		ID:            "test-session",
		ProjectID:     project.ID,
		WorkspaceID:   workspace.ID,
		AgentID:       ptrString(agent.ID),
		Name:          "Test Session",
		Status:        model.SessionStatusReady,
		CommitStatus:  model.CommitStatusCompleted,
		BaseCommit:    ptrString(initialCommit),
		AppliedCommit: ptrString("abc123"),
	}
	if err := env.store.CreateSession(context.Background(), session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	handler := newMockHandler()
	env.mockSandbox.HTTPHandler = handler

	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit - should be a no-op
	err := sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify no requests were made
	if handler.getChatRequestCount() != 0 {
		t.Errorf("Expected 0 chat requests for completed session, got %d", handler.getChatRequestCount())
	}
	if handler.getCommitsRequestCount() != 0 {
		t.Errorf("Expected 0 commits requests for completed session, got %d", handler.getCommitsRequestCount())
	}
}

// TestPerformCommit_NotPendingOrCommitting tests that we skip sessions not in pending/committing state.
func TestPerformCommit_NotPendingOrCommitting(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with "none" commit status
	session := &model.Session{
		ID:           "test-session",
		ProjectID:    project.ID,
		WorkspaceID:  workspace.ID,
		AgentID:      ptrString(agent.ID),
		Name:         "Test Session",
		Status:       model.SessionStatusReady,
		CommitStatus: model.CommitStatusNone,
		BaseCommit:   ptrString(initialCommit),
	}
	if err := env.store.CreateSession(context.Background(), session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	handler := newMockHandler()
	env.mockSandbox.HTTPHandler = handler

	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit - should be a no-op
	err := sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// Verify no requests were made
	if handler.getChatRequestCount() != 0 {
		t.Errorf("Expected 0 chat requests, got %d", handler.getChatRequestCount())
	}
}

// TestPerformCommit_WorkspaceUnchangedWithExistingPatches tests that the optimistic
// patch check runs even when workspace commit hasn't changed, allowing us to skip
// the /octobot-commit prompt if the agent already has patches ready.
func TestPerformCommit_WorkspaceUnchangedWithExistingPatches(t *testing.T) {
	env := newTestEnv(t)
	defer env.cleanup()

	project := env.createTestProject(t)
	agent := env.createTestAgent(t, project.ID)
	workspace, initialCommit := env.createTestWorkspace(t, project.ID)

	// Create session with baseCommit equal to workspace commit (no change scenario)
	session := env.createTestSession(t, project.ID, workspace.ID, agent.ID, initialCommit)

	// Set up mock handler with patches already available
	// This simulates the agent having already created commits
	handler := newMockHandler()
	handler.commitsResponse = &sandboxapi.CommitsResponse{
		Patches: `From abc123 Mon Sep 17 00:00:00 2001
From: Agent <agent@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: Pre-existing agent work

---
 preexisting.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/preexisting.txt b/preexisting.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/preexisting.txt
@@ -0,0 +1 @@
+pre-existing work from agent
--
`,
		CommitCount: 1,
	}
	env.mockSandbox.HTTPHandler = handler

	// Create and start sandbox
	_, err := env.mockSandbox.Create(context.Background(), session.ID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("Failed to create sandbox: %v", err)
	}
	if err := env.mockSandbox.Start(context.Background(), session.ID); err != nil {
		t.Fatalf("Failed to start sandbox: %v", err)
	}

	// Create session service
	sessionSvc := NewSessionService(env.store, env.gitService, nil, env.mockSandbox, env.eventBroker)

	// Run PerformCommit
	err = sessionSvc.PerformCommit(context.Background(), project.ID, session.ID)
	if err != nil {
		t.Fatalf("PerformCommit failed: %v", err)
	}

	// KEY ASSERTION: should NOT have sent /octobot-commit because optimistic check
	// found existing patches and applied them directly
	if handler.getChatRequestCount() != 0 {
		t.Errorf("Expected 0 chat requests (optimistic path should skip prompt), got %d", handler.getChatRequestCount())
	}

	// Verify: should have called GetCommits once (the optimistic check)
	if handler.getCommitsRequestCount() != 1 {
		t.Errorf("Expected 1 commits request (optimistic check), got %d", handler.getCommitsRequestCount())
	}

	// Verify session completed successfully
	updatedSession, err := env.store.GetSessionByID(context.Background(), session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}

	// BaseCommit should remain unchanged
	if updatedSession.BaseCommit == nil || *updatedSession.BaseCommit != initialCommit {
		t.Errorf("Expected baseCommit to remain %s, got %v", initialCommit, updatedSession.BaseCommit)
	}

	if updatedSession.CommitStatus != model.CommitStatusCompleted {
		t.Errorf("Expected commit status %s, got %s", model.CommitStatusCompleted, updatedSession.CommitStatus)
	}

	if updatedSession.AppliedCommit == nil || *updatedSession.AppliedCommit == "" {
		t.Error("Expected appliedCommit to be set")
	}
}

// trackingHandler is a custom handler that allows separate handling of chat and commits.
type trackingHandler struct {
	onChat    func(w http.ResponseWriter, r *http.Request)
	onCommits func(w http.ResponseWriter, r *http.Request)
}

func (h *trackingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/chat" && r.Method == "POST":
		if h.onChat != nil {
			h.onChat(w, r)
		}
	case r.URL.Path == "/chat" && r.Method == "GET":
		// Return SSE stream for GET /chat
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, "data: [DONE]\n\n")
	case r.URL.Path == "/commits" && r.Method == "GET":
		if h.onCommits != nil {
			h.onCommits(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}
