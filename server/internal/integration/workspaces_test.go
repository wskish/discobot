package integration

import (
	"net/http"
	"testing"

)

func TestListWorkspaces_Empty(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var workspaces []interface{}
	ParseJSON(t, resp, &workspaces)

	if len(workspaces) != 0 {
		t.Errorf("Expected 0 workspaces, got %d", len(workspaces))
	}
}

func TestCreateWorkspace(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{
		"path":       "/home/user/code",
		"sourceType": "local",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var workspace map[string]interface{}
	ParseJSON(t, resp, &workspace)

	if workspace["path"] != "/home/user/code" {
		t.Errorf("Expected path '/home/user/code', got '%v'", workspace["path"])
	}
	if workspace["sourceType"] != "local" {
		t.Errorf("Expected sourceType 'local', got '%v'", workspace["sourceType"])
	}
}

func TestCreateWorkspace_MissingPath(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestCreateWorkspace_DefaultSourceType(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{
		"path": "/home/user/code",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var workspace map[string]interface{}
	ParseJSON(t, resp, &workspace)

	if workspace["sourceType"] != "local" {
		t.Errorf("Expected default sourceType 'local', got '%v'", workspace["sourceType"])
	}
}

func TestGetWorkspace(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["id"] != workspace.ID {
		t.Errorf("Expected id '%s', got '%v'", workspace.ID, result["id"])
	}
}

func TestUpdateWorkspace(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID+"/workspaces/"+workspace.ID, map[string]string{
		"name": "Updated Workspace",
		"path": "/home/user/new-path",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["name"] != "Updated Workspace" {
		t.Errorf("Expected name 'Updated Workspace', got '%v'", result["name"])
	}
}

func TestDeleteWorkspace(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Delete("/api/projects/" + project.ID + "/workspaces/" + workspace.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify workspace is deleted
	resp = client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
}

func TestListWorkspaces_WithData(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	ts.CreateTestWorkspace(project, "/home/user/project1")
	ts.CreateTestWorkspace(project, "/home/user/project2")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var workspaces []interface{}
	ParseJSON(t, resp, &workspaces)

	if len(workspaces) != 2 {
		t.Errorf("Expected 2 workspaces, got %d", len(workspaces))
	}
}
