package integration

import (
	"net/http"
	"testing"
)

func TestGetAgentTypes(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/agents/types")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		AgentTypes []map[string]interface{} `json:"agentTypes"`
	}
	ParseJSON(t, resp, &result)

	if len(result.AgentTypes) == 0 {
		t.Error("Expected at least one agent type")
	}

	// Check that claude-code is in the list
	found := false
	for _, agentType := range result.AgentTypes {
		if agentType["id"] == "claude-code" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find 'claude-code' agent type")
	}
}

func TestListAgents_Empty(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/agents")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Agents []interface{} `json:"agents"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Agents) != 0 {
		t.Errorf("Expected 0 agents, got %d", len(result.Agents))
	}
}

func TestCreateAgent(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents", map[string]interface{}{
		"name":        "My Claude Agent",
		"description": "A custom Claude agent",
		"agentType":   "claude-code",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var agent map[string]interface{}
	ParseJSON(t, resp, &agent)

	if agent["name"] != "My Claude Agent" {
		t.Errorf("Expected name 'My Claude Agent', got '%v'", agent["name"])
	}
	if agent["agentType"] != "claude-code" {
		t.Errorf("Expected agentType 'claude-code', got '%v'", agent["agentType"])
	}
}

func TestCreateAgent_WithSystemPrompt(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents", map[string]interface{}{
		"name":         "Custom Agent",
		"agentType":    "claude-code",
		"systemPrompt": "You are a helpful assistant.",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var agent map[string]interface{}
	ParseJSON(t, resp, &agent)

	if agent["systemPrompt"] != "You are a helpful assistant." {
		t.Errorf("Expected systemPrompt 'You are a helpful assistant.', got '%v'", agent["systemPrompt"])
	}
}

func TestCreateAgent_MissingName(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents", map[string]interface{}{
		"agentType": "claude-code",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestCreateAgent_MissingType(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents", map[string]interface{}{
		"name": "Agent without type",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestGetAgent(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/agents/" + agent.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["id"] != agent.ID {
		t.Errorf("Expected id '%s', got '%v'", agent.ID, result["id"])
	}
	if result["name"] != "Test Agent" {
		t.Errorf("Expected name 'Test Agent', got '%v'", result["name"])
	}
}

func TestUpdateAgent(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID+"/agents/"+agent.ID, map[string]interface{}{
		"name":        "Updated Agent",
		"description": "New description",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["name"] != "Updated Agent" {
		t.Errorf("Expected name 'Updated Agent', got '%v'", result["name"])
	}
	if result["description"] != "New description" {
		t.Errorf("Expected description 'New description', got '%v'", result["description"])
	}
}

func TestDeleteAgent(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	resp := client.Delete("/api/projects/" + project.ID + "/agents/" + agent.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify agent is deleted
	resp = client.Get("/api/projects/" + project.ID + "/agents/" + agent.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
}

func TestSetDefaultAgent(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	agent := ts.CreateTestAgent(project, "Test Agent", "claude-code")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents/default", map[string]string{
		"agentId": agent.ID,
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]bool
	ParseJSON(t, resp, &result)

	if !result["success"] {
		t.Error("Expected success to be true")
	}
}

func TestSetDefaultAgent_MissingAgentId(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/agents/default", map[string]string{})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestListAgents_WithData(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	ts.CreateTestAgent(project, "Claude Agent", "claude-code")
	ts.CreateTestAgent(project, "Aider Agent", "aider")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/agents")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Agents []interface{} `json:"agents"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Agents) != 2 {
		t.Errorf("Expected 2 agents, got %d", len(result.Agents))
	}
}
