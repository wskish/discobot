package integration

import (
	"net/http"
	"testing"
)

func TestListProjects_Unauthenticated(t *testing.T) {
	ts := NewTestServer(t)

	resp, err := http.Get(ts.Server.URL + "/api/projects")
	if err != nil {
		t.Fatalf("Failed to list projects: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusUnauthorized)
}

func TestListProjects_Empty(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var projects []interface{}
	ParseJSON(t, resp, &projects)

	if len(projects) != 0 {
		t.Errorf("Expected 0 projects, got %d", len(projects))
	}
}

func TestCreateProject(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects", map[string]string{
		"name": "Test Project",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var project map[string]interface{}
	ParseJSON(t, resp, &project)

	if project["name"] != "Test Project" {
		t.Errorf("Expected name 'Test Project', got '%v'", project["name"])
	}
	if project["id"] == nil || project["id"] == "" {
		t.Error("Expected project to have an ID")
	}
}

func TestCreateProject_MissingName(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects", map[string]string{})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestGetProject(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["id"] != project.ID {
		t.Errorf("Expected id '%s', got '%v'", project.ID, result["id"])
	}
}

func TestGetProject_NotMember(t *testing.T) {
	ts := NewTestServer(t)
	owner := ts.CreateTestUser("owner@example.com")
	other := ts.CreateTestUser("other@example.com")
	project := ts.CreateTestProject(owner, "Test Project")
	client := ts.AuthenticatedClient(other)

	resp := client.Get("/api/projects/" + project.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusForbidden)
}

func TestUpdateProject(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID, map[string]string{
		"name": "Updated Project",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["name"] != "Updated Project" {
		t.Errorf("Expected name 'Updated Project', got '%v'", result["name"])
	}
}

func TestDeleteProject(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Delete("/api/projects/" + project.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify project is deleted
	resp = client.Get("/api/projects/" + project.ID)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusForbidden) // No longer a member since project is deleted
}

func TestListProjectMembers(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/members")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var members []map[string]interface{}
	ParseJSON(t, resp, &members)

	if len(members) != 1 {
		t.Errorf("Expected 1 member, got %d", len(members))
	}
}

func TestCreateInvitation(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/invitations", map[string]string{
		"email": "newuser@example.com",
		"role":  "member",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var invitation map[string]interface{}
	ParseJSON(t, resp, &invitation)

	if invitation["email"] != "newuser@example.com" {
		t.Errorf("Expected email 'newuser@example.com', got '%v'", invitation["email"])
	}
}
