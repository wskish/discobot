package integration

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/anthropics/octobot/server/internal/git"
)

// createTestGitRepo creates a test git repository with some initial content
func createTestGitRepo(t *testing.T) string {
	t.Helper()

	dir := t.TempDir()

	// Initialize git repo
	runGit(t, dir, "init")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test User")

	// Create initial file
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test Repo\n"), 0644); err != nil {
		t.Fatalf("Failed to create README.md: %v", err)
	}

	// Create another file
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0644); err != nil {
		t.Fatalf("Failed to create main.go: %v", err)
	}

	// Commit
	runGit(t, dir, "add", ".")
	runGit(t, dir, "commit", "-m", "Initial commit")

	return dir
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\nOutput: %s", args, err, output)
	}
	return string(output)
}

func TestGitStatus(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	// Create a test git repo
	repoPath := createTestGitRepo(t)

	// Create workspace pointing to the test repo
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Get git status
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/status", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var status git.Status
	ParseJSON(t, resp, &status)

	if status.Branch != "master" && status.Branch != "main" {
		t.Errorf("Expected branch master or main, got %s", status.Branch)
	}

	if !status.IsClean {
		t.Error("Expected clean working tree")
	}

	if status.Commit == "" {
		t.Error("Expected commit SHA")
	}
}

func TestGitBranches(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	// Create a test git repo with multiple branches
	repoPath := createTestGitRepo(t)
	runGit(t, repoPath, "branch", "feature-branch")
	runGit(t, repoPath, "branch", "dev")

	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Get branches
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/branches", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Branches []git.Branch `json:"branches"`
	}
	ParseJSON(t, resp, &result)

	// Should have at least 3 branches (main/master, feature-branch, dev)
	if len(result.Branches) < 3 {
		t.Errorf("Expected at least 3 branches, got %d", len(result.Branches))
	}

	// One should be current
	hasCurrentBranch := false
	for _, b := range result.Branches {
		if b.IsCurrent {
			hasCurrentBranch = true
			break
		}
	}

	if !hasCurrentBranch {
		t.Error("Expected one branch to be marked as current")
	}
}

func TestGitFileTree(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Get file tree
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/files", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Files []git.FileEntry `json:"files"`
	}
	ParseJSON(t, resp, &result)

	// Should have README.md and main.go
	if len(result.Files) < 2 {
		t.Errorf("Expected at least 2 files, got %d", len(result.Files))
	}

	hasReadme := false
	hasMainGo := false
	for _, f := range result.Files {
		if f.Path == "README.md" {
			hasReadme = true
		}
		if f.Path == "main.go" {
			hasMainGo = true
		}
	}

	if !hasReadme {
		t.Error("Expected README.md in file tree")
	}
	if !hasMainGo {
		t.Error("Expected main.go in file tree")
	}
}

func TestGitReadFile(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Read file from working tree
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/file?path=README.md", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	ParseJSON(t, resp, &result)

	if result.Path != "README.md" {
		t.Errorf("Expected path README.md, got %s", result.Path)
	}

	if result.Content != "# Test Repo\n" {
		t.Errorf("Unexpected content: %s", result.Content)
	}
}

func TestGitWriteAndStage(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Write a new file
	resp := client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/file", project.ID, workspace.ID), map[string]string{
		"path":    "newfile.txt",
		"content": "Hello, World!\n",
	})
	AssertStatus(t, resp, http.StatusOK)

	// Check status - should show untracked file
	resp = client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/status", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var status git.Status
	ParseJSON(t, resp, &status)

	if len(status.Untracked) == 0 {
		t.Error("Expected untracked files")
	}

	// Stage the file
	resp = client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/stage", project.ID, workspace.ID), map[string][]string{
		"paths": {"newfile.txt"},
	})
	AssertStatus(t, resp, http.StatusOK)

	// Check status - should show staged file
	resp = client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/status", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	ParseJSON(t, resp, &status)

	if len(status.Staged) == 0 {
		t.Error("Expected staged files")
	}
}

func TestGitCommit(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Write and stage a new file
	client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/file", project.ID, workspace.ID), map[string]string{
		"path":    "newfile.txt",
		"content": "Hello, World!\n",
	})
	client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/stage", project.ID, workspace.ID), map[string][]string{
		"paths": {"newfile.txt"},
	})

	// Commit
	resp := client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/commit", project.ID, workspace.ID), map[string]string{
		"message":     "Add newfile.txt",
		"authorName":  "Test Author",
		"authorEmail": "author@example.com",
	})
	AssertStatus(t, resp, http.StatusCreated)

	var commit git.Commit
	ParseJSON(t, resp, &commit)

	if commit.SHA == "" {
		t.Error("Expected commit SHA")
	}
	if commit.Message != "Add newfile.txt" {
		t.Errorf("Expected message 'Add newfile.txt', got %s", commit.Message)
	}
}

func TestGitLog(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Get log
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/log", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Commits []git.Commit `json:"commits"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Commits) == 0 {
		t.Error("Expected at least one commit")
	}

	if result.Commits[0].Message != "Initial commit" {
		t.Errorf("Expected message 'Initial commit', got %s", result.Commits[0].Message)
	}
}

func TestGitDiff(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	repoPath := createTestGitRepo(t)
	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Modify a file
	client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/file", project.ID, workspace.ID), map[string]string{
		"path":    "README.md",
		"content": "# Test Repo\n\nUpdated content.\n",
	})

	// Get diff (unstaged)
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/diff", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Diffs []git.FileDiff `json:"diffs"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Diffs) == 0 {
		t.Error("Expected at least one diff")
	}

	if result.Diffs[0].Path != "README.md" {
		t.Errorf("Expected diff for README.md, got %s", result.Diffs[0].Path)
	}
}

func TestGitCheckout(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("gituser@example.com")
	project := ts.CreateTestProject(user, "test-project")
	client := ts.AuthenticatedClient(user)

	// Create a test git repo with multiple branches
	repoPath := createTestGitRepo(t)
	runGit(t, repoPath, "branch", "feature-branch")

	workspace := ts.CreateTestWorkspace(project, repoPath)

	// Get current status
	resp := client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/status", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	var status git.Status
	ParseJSON(t, resp, &status)
	originalBranch := status.Branch

	// Checkout feature-branch
	resp = client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/checkout", project.ID, workspace.ID), map[string]string{
		"ref": "feature-branch",
	})
	AssertStatus(t, resp, http.StatusOK)

	// Verify we're on the new branch
	resp = client.Get(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/status", project.ID, workspace.ID))
	AssertStatus(t, resp, http.StatusOK)

	ParseJSON(t, resp, &status)
	if status.Branch != "feature-branch" {
		t.Errorf("Expected branch feature-branch, got %s", status.Branch)
	}

	// Checkout back to original
	resp = client.Post(fmt.Sprintf("/api/projects/%s/workspaces/%s/git/checkout", project.ID, workspace.ID), map[string]string{
		"ref": originalBranch,
	})
	AssertStatus(t, resp, http.StatusOK)
}

func TestGitLocalProviderCaching(t *testing.T) {
	// This test verifies the caching behavior of the local provider
	gitDir := t.TempDir()
	provider, err := git.NewLocalProvider(gitDir)
	if err != nil {
		t.Fatalf("Failed to create provider: %v", err)
	}

	// Create a test repo to use as "remote"
	remoteRepo := createTestGitRepo(t)

	// Clone to two different workspace IDs
	workDir1, err := provider.EnsureWorkspace(t.Context(), "workspace-1", remoteRepo, "")
	if err != nil {
		t.Fatalf("Failed to ensure workspace 1: %v", err)
	}

	workDir2, err := provider.EnsureWorkspace(t.Context(), "workspace-2", remoteRepo, "")
	if err != nil {
		t.Fatalf("Failed to ensure workspace 2: %v", err)
	}

	// Verify they have different working directories
	if workDir1 == workDir2 {
		t.Error("Expected different working directories for different workspaces")
	}

	// Verify both can get status
	status1, err := provider.Status(t.Context(), "workspace-1")
	if err != nil {
		t.Fatalf("Failed to get status for workspace 1: %v", err)
	}

	status2, err := provider.Status(t.Context(), "workspace-2")
	if err != nil {
		t.Fatalf("Failed to get status for workspace 2: %v", err)
	}

	// Both should have the same commit
	if status1.Commit != status2.Commit {
		t.Errorf("Expected same commit in both workspaces, got %s and %s", status1.Commit, status2.Commit)
	}

	// Make changes in workspace 1
	if err := provider.WriteFile(t.Context(), "workspace-1", "new-in-ws1.txt", []byte("from ws1\n")); err != nil {
		t.Fatalf("Failed to write file: %v", err)
	}

	// Workspace 2 should not see the change
	_, err = provider.ReadFile(t.Context(), "workspace-2", "", "new-in-ws1.txt")
	if err == nil {
		t.Error("Expected workspace 2 to not see workspace 1's uncommitted file")
	}
}
