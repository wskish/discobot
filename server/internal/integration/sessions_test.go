package integration

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListSessionsByWorkspace_Empty(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID + "/sessions")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Sessions []interface{} `json:"sessions"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Sessions) != 0 {
		t.Errorf("Expected 0 sessions, got %d", len(result.Sessions))
	}
}

func TestCreateSession_ViaChat(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	// Sessions are created implicitly via the chat endpoint
	// Format matches AI SDK's DefaultChatTransport with UIMessage format
	sessionID := "test-session-id-1"
	resp := client.Post("/api/projects/"+project.ID+"/chat", map[string]interface{}{
		"id": sessionID,
		"messages": []map[string]interface{}{
			{
				"id":   "msg-1",
				"role": "user",
				"parts": []map[string]interface{}{
					{"type": "text", "text": "Create a new session"},
				},
			},
		},
		"workspaceId": workspace.ID,
		"agentId":     agent.ID,
	})
	defer resp.Body.Close()

	// Chat endpoint returns 200 with SSE stream
	AssertStatus(t, resp, http.StatusOK)

	// Verify session was created by listing sessions
	listResp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID + "/sessions")
	defer listResp.Body.Close()

	var result struct {
		Sessions []map[string]interface{} `json:"sessions"`
	}
	ParseJSON(t, listResp, &result)

	if len(result.Sessions) != 1 {
		t.Errorf("Expected 1 session, got %d", len(result.Sessions))
		return
	}

	// Session name is derived from the prompt
	if result.Sessions[0]["name"] != "Create a new session" {
		t.Errorf("Expected name derived from prompt, got '%v'", result.Sessions[0]["name"])
	}
}

func TestCreateSession_ViaChatWithAgent(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	agent := ts.CreateTestAgent(project, "Claude", "claude-code")
	client := ts.AuthenticatedClient(user)

	// Sessions are created implicitly via the chat endpoint with agent
	// Format matches AI SDK's DefaultChatTransport with UIMessage format
	sessionID := "test-session-id-2"
	resp := client.Post("/api/projects/"+project.ID+"/chat", map[string]interface{}{
		"id": sessionID,
		"messages": []map[string]interface{}{
			{
				"id":   "msg-1",
				"role": "user",
				"parts": []map[string]interface{}{
					{"type": "text", "text": "Hello agent"},
				},
			},
		},
		"workspaceId": workspace.ID,
		"agentId":     agent.ID,
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify session was created with agent by listing sessions
	listResp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID + "/sessions")
	defer listResp.Body.Close()

	var result struct {
		Sessions []map[string]interface{} `json:"sessions"`
	}
	ParseJSON(t, listResp, &result)

	if len(result.Sessions) != 1 {
		t.Errorf("Expected 1 session, got %d", len(result.Sessions))
		return
	}

	if result.Sessions[0]["agentId"] != agent.ID {
		t.Errorf("Expected agentId '%s', got '%v'", agent.ID, result.Sessions[0]["agentId"])
	}
}

func TestCreateSession_NameFromLongPrompt(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	// Session name is derived from prompt, truncated to 50 chars
	longPrompt := "This is a very long prompt that should be truncated to fit within the 50 character limit for session names"
	sessionID := "test-session-id-3"
	resp := client.Post("/api/projects/"+project.ID+"/chat", map[string]interface{}{
		"id": sessionID,
		"messages": []map[string]interface{}{
			{
				"id":   "msg-1",
				"role": "user",
				"parts": []map[string]interface{}{
					{"type": "text", "text": longPrompt},
				},
			},
		},
		"workspaceId": workspace.ID,
		"agentId":     agent.ID,
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify session name was truncated
	listResp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID + "/sessions")
	defer listResp.Body.Close()

	var result struct {
		Sessions []map[string]interface{} `json:"sessions"`
	}
	ParseJSON(t, listResp, &result)

	if len(result.Sessions) != 1 {
		t.Errorf("Expected 1 session, got %d", len(result.Sessions))
		return
	}

	name := result.Sessions[0]["name"].(string)
	if len(name) > 53 { // 50 chars + "..."
		t.Errorf("Expected name to be truncated, got length %d", len(name))
	}
}

func TestGetSession(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["id"] != session.ID {
		t.Errorf("Expected id '%s', got '%v'", session.ID, result["id"])
	}
	if result["name"] != "Test Session" {
		t.Errorf("Expected name 'Test Session', got '%v'", result["name"])
	}
}

func TestUpdateSession(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID+"/sessions/"+session.ID, map[string]string{
		"name":   "Updated Session",
		"status": "closed",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["name"] != "Updated Session" {
		t.Errorf("Expected name 'Updated Session', got '%v'", result["name"])
	}
	if result["status"] != "closed" {
		t.Errorf("Expected status 'closed', got '%v'", result["status"])
	}
}

func TestDeleteSession(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	resp := client.Delete("/api/projects/" + project.ID + "/sessions/" + session.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify session status is "removing" (async deletion)
	resp = client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)
	var result map[string]interface{}
	ParseJSON(t, resp, &result)
	if result["status"] != "removing" {
		t.Errorf("Expected status 'removing', got '%v'", result["status"])
	}
}

func TestListSessionsByWorkspace_WithData(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	ts.CreateTestSession(workspace, "Session 1")
	ts.CreateTestSession(workspace, "Session 2")
	ts.CreateTestSession(workspace, "Session 3")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID + "/sessions")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Sessions []interface{} `json:"sessions"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Sessions) != 3 {
		t.Errorf("Expected 3 sessions, got %d", len(result.Sessions))
	}
}

func TestGetSessionFiles(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	// Currently returns empty array (TODO endpoint)
	resp := client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID + "/files")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Files []interface{} `json:"files"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Files) != 0 {
		t.Errorf("Expected 0 files (TODO endpoint), got %d", len(result.Files))
	}
}

func TestListMessages(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")

	// Set up mock sandbox HTTP server that responds to /chat
	mockSandboxServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/chat" && r.Method == "GET" && r.Header.Get("Accept") != "text/event-stream" {
			// Return empty messages array
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"messages":[]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer mockSandboxServer.Close()

	// Create session with sandbox using mock server
	session := ts.CreateTestSessionWithMockSandbox(workspace, agent, "Test Session", mockSandboxServer.URL)
	client := ts.AuthenticatedClient(user)

	// Get messages from sandbox - returns empty since no messages have been sent
	resp := client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID + "/messages")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Messages []interface{} `json:"messages"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Messages) != 0 {
		t.Errorf("Expected 0 messages, got %d", len(result.Messages))
	}
}
