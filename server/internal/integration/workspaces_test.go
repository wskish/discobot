package integration

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/obot-platform/octobot/server/internal/model"
)

// createWorkspaceTestGitRepo creates a test git repository for workspace initialization tests
func createWorkspaceTestGitRepo(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()

	// Initialize git repo
	runWorkspaceGit(t, dir, "init")
	runWorkspaceGit(t, dir, "config", "user.email", "test@example.com")
	runWorkspaceGit(t, dir, "config", "user.name", "Test User")

	// Create initial file
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Repo\n"), 0644); err != nil {
		t.Fatalf("Failed to create README.md: %v", err)
	}

	// Commit
	runWorkspaceGit(t, dir, "add", ".")
	runWorkspaceGit(t, dir, "commit", "-m", "Initial commit")

	return dir
}

func runWorkspaceGit(t *testing.T, dir string, args ...string) string {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\nOutput: %s", args, err, output)
	}
	return string(output)
}

func TestListWorkspaces_Empty(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Workspaces []interface{} `json:"workspaces"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Workspaces) != 0 {
		t.Errorf("Expected 0 workspaces, got %d", len(result.Workspaces))
	}
}

func TestCreateWorkspace(t *testing.T) {
	t.Parallel()
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
	// New workspace should start in initializing status
	if workspace["status"] != model.WorkspaceStatusInitializing {
		t.Errorf("Expected status '%s', got '%v'", model.WorkspaceStatusInitializing, workspace["status"])
	}
}

func TestCreateWorkspace_MissingPath(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestCreateWorkspace_DefaultSourceType(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID+"/workspaces/"+workspace.ID, map[string]string{
		"path": "/home/user/new-path",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["path"] != "/home/user/new-path" {
		t.Errorf("Expected path '/home/user/new-path', got '%v'", result["path"])
	}
}

func TestDeleteWorkspace(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	ts.CreateTestWorkspace(project, "/home/user/project1")
	ts.CreateTestWorkspace(project, "/home/user/project2")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/projects/" + project.ID + "/workspaces")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Workspaces []interface{} `json:"workspaces"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Workspaces) != 2 {
		t.Errorf("Expected 2 workspaces, got %d", len(result.Workspaces))
	}
}

func TestCreateWorkspace_TildeExpansion(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{
		"path":       "~/code/myproject",
		"sourceType": "local",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusCreated)

	var workspace map[string]interface{}
	ParseJSON(t, resp, &workspace)

	path := workspace["path"].(string)
	// Path should not contain ~
	if path == "~/code/myproject" || path[0] == '~' {
		t.Errorf("Expected tilde to be expanded, got '%v'", path)
	}
	// Path should contain /code/myproject
	if !filepath.IsAbs(path) {
		t.Errorf("Expected absolute path, got '%v'", path)
	}
	// Path should end with /code/myproject
	homeDir, _ := os.UserHomeDir()
	expected := filepath.Join(homeDir, "code/myproject")
	if path != expected {
		t.Errorf("Expected path '%s', got '%s'", expected, path)
	}
}

func TestUpdateWorkspace_TildeExpansion(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	workspace := ts.CreateTestWorkspace(project, "/home/user/code")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/projects/"+project.ID+"/workspaces/"+workspace.ID, map[string]string{
		"path": "~/projects/newpath",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	path := result["path"].(string)
	// Path should not contain ~
	if path == "~/projects/newpath" || path[0] == '~' {
		t.Errorf("Expected tilde to be expanded, got '%v'", path)
	}
	// Path should be absolute
	if !filepath.IsAbs(path) {
		t.Errorf("Expected absolute path, got '%v'", path)
	}
	// Path should end with /projects/newpath
	homeDir, _ := os.UserHomeDir()
	expected := filepath.Join(homeDir, "projects/newpath")
	if path != expected {
		t.Errorf("Expected path '%s', got '%s'", expected, path)
	}
}

func TestWorkspaceInitialization_Local(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	project := ts.CreateTestProject(user, "Test Project")
	client := ts.AuthenticatedClient(user)

	// Create a test git repo to use as the workspace source
	localPath := createWorkspaceTestGitRepo(t)
	resp := client.Post("/api/projects/"+project.ID+"/workspaces", map[string]string{
		"path":       localPath,
		"sourceType": "local",
	})
	AssertStatus(t, resp, http.StatusCreated)

	var workspace struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	ParseJSON(t, resp, &workspace)

	// Should start as initializing
	if workspace.Status != model.WorkspaceStatusInitializing {
		t.Errorf("Expected initial status '%s', got '%s'", model.WorkspaceStatusInitializing, workspace.Status)
	}

	// Wait for initialization job to complete (poll for ready status)
	var finalStatus string
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp = client.Get("/api/projects/" + project.ID + "/workspaces/" + workspace.ID)
		var ws struct {
			Status string `json:"status"`
			Commit string `json:"commit"`
		}
		ParseJSON(t, resp, &ws)
		finalStatus = ws.Status

		if ws.Status == model.WorkspaceStatusReady {
			// Successfully initialized - commit should be set
			if ws.Commit == "" {
				t.Error("Expected commit to be set after initialization")
			}
			return
		}
		if ws.Status == model.WorkspaceStatusError {
			t.Fatalf("Workspace initialization failed with error status")
		}
		time.Sleep(50 * time.Millisecond)
	}

	t.Errorf("Workspace did not reach ready status within timeout, final status: %s", finalStatus)
}
