package integration

import (
	"context"
	"strings"
	"testing"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/service"
)

// TestSessionInitialize_NilAgentFallsBackToDefault verifies that when a session
// has no agent assigned (AgentID is nil), it automatically uses the default agent.
func TestSessionInitialize_NilAgentFallsBackToDefault(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")

	// Create a workspace with a real git repo
	workspace := ts.CreateTestWorkspaceWithGitRepo(project)

	// Create a default agent
	defaultAgent := ts.CreateTestAgent(project, "Default Agent", "claude-code")
	ctx := context.Background()
	if err := ts.Store.SetDefaultAgent(ctx, project.ID, defaultAgent.ID); err != nil {
		t.Fatalf("Failed to set default agent: %v", err)
	}

	// Create session with NO agent assigned (AgentID is nil)
	session := &model.Session{
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		AgentID:     nil, // No agent assigned
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
	}
	if err := ts.Store.CreateSession(ctx, session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Verify session has no agent
	freshSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if freshSession.AgentID != nil {
		t.Errorf("Expected AgentID to be nil before init, got %v", *freshSession.AgentID)
	}

	// Initialize session
	gitSvc := service.NewGitService(ts.Store, ts.GitProvider)
	sessionSvc := service.NewSessionService(ts.Store, gitSvc, nil, ts.MockSandbox, nil, nil)

	if err := sessionSvc.Initialize(ctx, session.ID); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	// Verify session was assigned the default agent
	updatedSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updatedSession.AgentID == nil {
		t.Fatal("Expected AgentID to be set after initialization")
	}

	if *updatedSession.AgentID != defaultAgent.ID {
		t.Errorf("Expected AgentID to be %s (default agent), got %s", defaultAgent.ID, *updatedSession.AgentID)
	}

	// Verify session initialized successfully
	if updatedSession.Status != model.SessionStatusReady {
		t.Errorf("Expected session status to be ready, got %s", updatedSession.Status)
	}
}

// TestSessionInitialize_DeletedAgentFallsBackToDefault verifies that when a session's
// agent has been deleted, it automatically uses the default agent.
func TestSessionInitialize_DeletedAgentFallsBackToDefault(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")

	// Create a workspace with a real git repo
	workspace := ts.CreateTestWorkspaceWithGitRepo(project)

	// Create two agents: one to be deleted, one to be the default
	deletedAgent := ts.CreateTestAgent(project, "Agent To Delete", "claude-code")
	defaultAgent := ts.CreateTestAgent(project, "Default Agent", "claude-code")

	ctx := context.Background()
	if err := ts.Store.SetDefaultAgent(ctx, project.ID, defaultAgent.ID); err != nil {
		t.Fatalf("Failed to set default agent: %v", err)
	}

	// Create session with the agent that will be deleted
	session := &model.Session{
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		AgentID:     &deletedAgent.ID,
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
	}
	if err := ts.Store.CreateSession(ctx, session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Delete the agent (this should nullify session.AgentID)
	if err := ts.Store.DeleteAgent(ctx, deletedAgent.ID); err != nil {
		t.Fatalf("Failed to delete agent: %v", err)
	}

	// Verify session's AgentID was nullified
	freshSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get session: %v", err)
	}
	if freshSession.AgentID != nil {
		t.Errorf("Expected AgentID to be nil after agent deletion, got %v", *freshSession.AgentID)
	}

	// Initialize session
	gitSvc := service.NewGitService(ts.Store, ts.GitProvider)
	sessionSvc := service.NewSessionService(ts.Store, gitSvc, nil, ts.MockSandbox, nil, nil)

	if err := sessionSvc.Initialize(ctx, session.ID); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	// Verify session was assigned the default agent
	updatedSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updatedSession.AgentID == nil {
		t.Fatal("Expected AgentID to be set after initialization")
	}

	if *updatedSession.AgentID != defaultAgent.ID {
		t.Errorf("Expected AgentID to be %s (default agent), got %s", defaultAgent.ID, *updatedSession.AgentID)
	}

	// Verify session initialized successfully
	if updatedSession.Status != model.SessionStatusReady {
		t.Errorf("Expected session status to be ready, got %s", updatedSession.Status)
	}
}

// TestSessionInitialize_ValidAgentNoFallback verifies that when a session has
// a valid agent assigned, it uses that agent and does NOT fallback to default.
func TestSessionInitialize_ValidAgentNoFallback(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")

	// Create a workspace with a real git repo
	workspace := ts.CreateTestWorkspaceWithGitRepo(project)

	// Create two agents: one as default, one as the session's agent
	defaultAgent := ts.CreateTestAgent(project, "Default Agent", "claude-code")
	sessionAgent := ts.CreateTestAgent(project, "Session Agent", "opencode")

	ctx := context.Background()
	if err := ts.Store.SetDefaultAgent(ctx, project.ID, defaultAgent.ID); err != nil {
		t.Fatalf("Failed to set default agent: %v", err)
	}

	// Create session with specific agent
	session := &model.Session{
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		AgentID:     &sessionAgent.ID,
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
	}
	if err := ts.Store.CreateSession(ctx, session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Initialize session
	gitSvc := service.NewGitService(ts.Store, ts.GitProvider)
	sessionSvc := service.NewSessionService(ts.Store, gitSvc, nil, ts.MockSandbox, nil, nil)

	if err := sessionSvc.Initialize(ctx, session.ID); err != nil {
		t.Fatalf("Initialize failed: %v", err)
	}

	// Verify session still uses the original agent (NOT the default)
	updatedSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updatedSession.AgentID == nil {
		t.Fatal("Expected AgentID to be set")
	}

	if *updatedSession.AgentID != sessionAgent.ID {
		t.Errorf("Expected AgentID to be %s (session agent), got %s", sessionAgent.ID, *updatedSession.AgentID)
	}

	if *updatedSession.AgentID == defaultAgent.ID {
		t.Error("Session should NOT have fallen back to default agent when valid agent exists")
	}

	// Verify session initialized successfully
	if updatedSession.Status != model.SessionStatusReady {
		t.Errorf("Expected session status to be ready, got %s", updatedSession.Status)
	}
}

// TestSessionInitialize_NoDefaultAgentError verifies that when a session has
// no agent and no default agent is configured, initialization fails with a clear error.
func TestSessionInitialize_NoDefaultAgentError(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")

	// Create a workspace with a real git repo
	workspace := ts.CreateTestWorkspaceWithGitRepo(project)

	// DO NOT create a default agent

	// Create session with NO agent assigned
	ctx := context.Background()
	session := &model.Session{
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		AgentID:     nil, // No agent assigned
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
	}
	if err := ts.Store.CreateSession(ctx, session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Initialize session (should fail)
	gitSvc := service.NewGitService(ts.Store, ts.GitProvider)
	sessionSvc := service.NewSessionService(ts.Store, gitSvc, nil, ts.MockSandbox, nil, nil)

	err := sessionSvc.Initialize(ctx, session.ID)
	if err == nil {
		t.Fatal("Expected Initialize to fail when no agent and no default agent, but it succeeded")
	}

	// Verify error message mentions no default agent
	expectedErrMsg := "no default agent is configured"
	if !strings.Contains(err.Error(), expectedErrMsg) {
		t.Errorf("Expected error to contain %q, got: %v", expectedErrMsg, err)
	}

	// Verify session status is error
	updatedSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updatedSession.Status != model.SessionStatusError {
		t.Errorf("Expected session status to be error, got %s", updatedSession.Status)
	}

	if updatedSession.ErrorMessage == nil {
		t.Fatal("Expected error message to be set")
	}

	if !strings.Contains(*updatedSession.ErrorMessage, "no default agent is configured") {
		t.Errorf("Expected error message to mention no default agent, got: %s", *updatedSession.ErrorMessage)
	}
}

// TestSessionInitialize_DeletedAgentNoDefaultError verifies that when a session's
// agent has been deleted and no default agent exists, initialization fails.
func TestSessionInitialize_DeletedAgentNoDefaultError(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")

	// Create a workspace with a real git repo
	workspace := ts.CreateTestWorkspaceWithGitRepo(project)

	// Create an agent that will be deleted
	deletedAgent := ts.CreateTestAgent(project, "Agent To Delete", "claude-code")

	// Create session with the agent
	ctx := context.Background()
	session := &model.Session{
		ProjectID:   project.ID,
		WorkspaceID: workspace.ID,
		AgentID:     &deletedAgent.ID,
		Name:        "Test Session",
		Status:      model.SessionStatusInitializing,
	}
	if err := ts.Store.CreateSession(ctx, session); err != nil {
		t.Fatalf("Failed to create session: %v", err)
	}

	// Delete the agent (and ensure no default agent exists)
	if err := ts.Store.DeleteAgent(ctx, deletedAgent.ID); err != nil {
		t.Fatalf("Failed to delete agent: %v", err)
	}

	// Initialize session (should fail)
	gitSvc := service.NewGitService(ts.Store, ts.GitProvider)
	sessionSvc := service.NewSessionService(ts.Store, gitSvc, nil, ts.MockSandbox, nil, nil)

	err := sessionSvc.Initialize(ctx, session.ID)
	if err == nil {
		t.Fatal("Expected Initialize to fail when agent deleted and no default agent, but it succeeded")
	}

	// Verify error message
	expectedErrMsg := "no default agent is configured"
	if !strings.Contains(err.Error(), expectedErrMsg) {
		t.Errorf("Expected error to contain %q, got: %v", expectedErrMsg, err)
	}

	// Verify session status is error
	updatedSession, err := ts.Store.GetSessionByID(ctx, session.ID)
	if err != nil {
		t.Fatalf("Failed to get updated session: %v", err)
	}

	if updatedSession.Status != model.SessionStatusError {
		t.Errorf("Expected session status to be error, got %s", updatedSession.Status)
	}
}
