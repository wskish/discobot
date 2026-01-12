package integration

import (
	"net/http"
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

	var sessions []interface{}
	ParseJSON(t, resp, &sessions)

	if len(sessions) != 0 {
		t.Errorf("Expected 0 sessions, got %d", len(sessions))
	}
}

func TestCreateSession(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces/"+workspace.ID+"/sessions", map[string]string{
		"name": "New Session",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var session map[string]interface{}
	ParseJSON(t, resp, &session)

	if session["name"] != "New Session" {
		t.Errorf("Expected name 'New Session', got '%v'", session["name"])
	}
	if session["status"] != "open" {
		t.Errorf("Expected status 'open', got '%v'", session["status"])
	}
}

func TestCreateSession_WithAgent(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	agent := ts.CreateTestAgent(project, "Claude", "claude-code")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces/"+workspace.ID+"/sessions", map[string]string{
		"name":    "Agent Session",
		"agentId": agent.ID,
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var session map[string]interface{}
	ParseJSON(t, resp, &session)

	if session["agentId"] != agent.ID {
		t.Errorf("Expected agentId '%s', got '%v'", agent.ID, session["agentId"])
	}
}

func TestCreateSession_MissingName(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces/"+workspace.ID+"/sessions", map[string]string{})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
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

	// Verify session is deleted
	resp = client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
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

	var sessions []interface{}
	ParseJSON(t, resp, &sessions)

	if len(sessions) != 3 {
		t.Errorf("Expected 3 sessions, got %d", len(sessions))
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

	var files []interface{}
	ParseJSON(t, resp, &files)

	if len(files) != 0 {
		t.Errorf("Expected 0 files (TODO endpoint), got %d", len(files))
	}
}

func TestListMessages(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	session := ts.CreateTestSession(workspace, "Test Session")
	client := ts.AuthenticatedClient(user)

	// Currently returns empty array (TODO endpoint)
	resp := client.Get("/api/projects/" + project.ID + "/sessions/" + session.ID + "/messages")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var messages []interface{}
	ParseJSON(t, resp, &messages)

	if len(messages) != 0 {
		t.Errorf("Expected 0 messages (TODO endpoint), got %d", len(messages))
	}
}
