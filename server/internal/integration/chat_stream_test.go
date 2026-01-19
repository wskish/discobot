package integration

import (
	"net/http"
	"testing"
)

func TestChatStream_SessionNotFound(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	// Request stream for non-existent session - should return 204 No Content
	resp := client.Get("/api/projects/" + project.ID + "/chat/nonexistent-session/stream")
	defer resp.Body.Close()

	// No session = no stream = 204 No Content
	AssertStatus(t, resp, http.StatusNoContent)
}

func TestChatStream_SessionBelongsToOtherProject(t *testing.T) {
	ts := NewTestServer(t)

	// Create two users with their own projects
	user1 := ts.CreateTestUser("user1@example.com")
	project1 := ts.CreateTestProject(user1, "Project 1")
	workspace1 := ts.CreateTestWorkspace(project1, "/home/user1/code")
	session1 := ts.CreateTestSession(workspace1, "Session 1")

	user2 := ts.CreateTestUser("user2@example.com")
	project2 := ts.CreateTestProject(user2, "Project 2")

	// User2 tries to access user1's session via their own project
	client2 := ts.AuthenticatedClient(user2)
	resp := client2.Get("/api/projects/" + project2.ID + "/chat/" + session1.ID + "/stream")
	defer resp.Body.Close()

	// Should return 403 Forbidden
	AssertStatus(t, resp, http.StatusForbidden)
}

func TestChatStream_ValidSession_NoActiveStream(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	// Request stream for valid session but no active completion
	// The mock sandbox will return an error (no sandbox running), which
	// should be handled gracefully as 204 No Content
	resp := client.Get("/api/projects/" + project.ID + "/chat/" + session.ID + "/stream")
	defer resp.Body.Close()

	// No sandbox/no active stream = 204 No Content
	AssertStatus(t, resp, http.StatusNoContent)
}

func TestChatStream_RequiresAuthentication(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")

	// Make unauthenticated request
	resp, err := http.Get(ts.Server.URL + "/api/projects/" + project.ID + "/chat/" + session.ID + "/stream")
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	// Should return 401 Unauthorized
	AssertStatus(t, resp, http.StatusUnauthorized)
}

func TestChatStream_MissingSessionId(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	// Request stream without session ID
	// chi router treats /chat//stream as /chat/{sessionId}/stream with empty sessionId
	// The handler validates and returns 400 Bad Request
	resp := client.Get("/api/projects/" + project.ID + "/chat//stream")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}
