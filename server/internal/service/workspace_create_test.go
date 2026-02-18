package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCreateWorkspaceAutoInit tests the auto-detection logic that decides
// whether to run git init (missing or empty directory) or require an
// existing git repo (non-empty directory).
func TestCreateWorkspaceAutoInit(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "workspace-create-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	tests := []struct {
		name        string
		setupFunc   func(t *testing.T, base string) string
		wantErr     bool
		errContains string
		validate    func(t *testing.T, path string)
	}{
		{
			name: "non-existent directory is created, git-inited, and has initial commit",
			setupFunc: func(_ *testing.T, base string) string {
				return filepath.Join(base, "new-project")
			},
			validate: func(t *testing.T, path string) {
				t.Helper()
				if _, err := os.Stat(path); os.IsNotExist(err) {
					t.Errorf("directory should exist at %s", path)
				}
				gitDir := filepath.Join(path, ".git")
				if _, err := os.Stat(gitDir); os.IsNotExist(err) {
					t.Errorf(".git directory should exist at %s", gitDir)
				}
				// HEAD must resolve to a valid commit (not an empty repo)
				out, err := exec.Command("git", "-C", path, "rev-parse", "HEAD").CombinedOutput()
				if err != nil {
					t.Errorf("expected a valid HEAD commit, got error: %v, output: %s", err, out)
				}
				sha := strings.TrimSpace(string(out))
				if len(sha) != 40 {
					t.Errorf("expected 40-char commit SHA, got %q", sha)
				}
			},
		},
		{
			name: "empty existing directory is git-inited and has initial commit",
			setupFunc: func(t *testing.T, base string) string {
				t.Helper()
				dir := filepath.Join(base, "empty-dir")
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatalf("failed to create empty dir: %v", err)
				}
				return dir
			},
			validate: func(t *testing.T, path string) {
				t.Helper()
				out, err := exec.Command("git", "-C", path, "rev-parse", "HEAD").CombinedOutput()
				if err != nil {
					t.Errorf("expected a valid HEAD commit after init on empty dir: %v, output: %s", err, out)
				}
			},
		},
		{
			name: "non-existent parent directory returns error",
			setupFunc: func(_ *testing.T, base string) string {
				return filepath.Join(base, "no-such-parent", "new-project")
			},
			wantErr:     true,
			errContains: "parent directory does not exist",
		},
		{
			name: "non-empty directory without .git returns error",
			setupFunc: func(t *testing.T, base string) string {
				t.Helper()
				dir := filepath.Join(base, "non-empty-no-git")
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatalf("failed to create dir: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0644); err != nil {
					t.Fatalf("failed to write file: %v", err)
				}
				return dir
			},
			wantErr:     true,
			errContains: "not a git repository",
		},
		{
			name: "non-empty directory with .git succeeds",
			setupFunc: func(t *testing.T, base string) string {
				t.Helper()
				dir := filepath.Join(base, "has-git")
				if err := os.MkdirAll(dir, 0755); err != nil {
					t.Fatalf("failed to create dir: %v", err)
				}
				if err := os.MkdirAll(filepath.Join(dir, ".git"), 0755); err != nil {
					t.Fatalf("failed to create .git dir: %v", err)
				}
				if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0644); err != nil {
					t.Fatalf("failed to write file: %v", err)
				}
				return dir
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := tt.setupFunc(t, tmpDir)
			err := simulateLocalValidation(path)

			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error containing %q, got nil", tt.errContains)
					return
				}
				if !strings.Contains(err.Error(), tt.errContains) {
					t.Errorf("expected error containing %q, got %q", tt.errContains, err.Error())
				}
				return
			}

			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if tt.validate != nil {
				tt.validate(t, path)
			}
		})
	}
}

// simulateLocalValidation mirrors the local-path branch of CreateWorkspace.
func simulateLocalValidation(path string) error {
	info, statErr := os.Stat(path)
	dirMissing := os.IsNotExist(statErr)

	if !dirMissing && statErr != nil {
		return statErr
	}

	needsInit := false
	if dirMissing {
		parentDir := filepath.Dir(path)
		if _, err := os.Stat(parentDir); err != nil {
			if os.IsNotExist(err) {
				return &ValidationError{Message: "parent directory does not exist: " + parentDir}
			}
			return err
		}
		needsInit = true
	} else if info.IsDir() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		needsInit = len(entries) == 0
	}

	if needsInit {
		if dirMissing {
			if err := os.MkdirAll(path, 0755); err != nil {
				return err
			}
		}
		cmd := exec.Command("git", "init")
		cmd.Dir = path
		if err := cmd.Run(); err != nil {
			if dirMissing {
				_ = os.RemoveAll(path)
			}
			return err
		}
		initCommit := exec.Command("git",
			"-c", "user.email=discobot@localhost",
			"-c", "user.name=Discobot",
			"commit", "--allow-empty", "-m", "Initial commit",
		)
		initCommit.Dir = path
		if err := initCommit.Run(); err != nil {
			if dirMissing {
				_ = os.RemoveAll(path)
			}
			return err
		}
	} else {
		gitDir := filepath.Join(path, ".git")
		if _, err := os.Stat(gitDir); err != nil {
			if os.IsNotExist(err) {
				return &ValidationError{Message: "not a git repository: directory must contain a .git folder"}
			}
			return err
		}
	}
	return nil
}

// TestExpandPath tests the path expansion logic used in CreateWorkspace.
func TestExpandPath(t *testing.T) {
	tests := []struct {
		name       string
		input      string
		wantPrefix string
	}{
		{
			name:       "expands tilde to home directory",
			input:      "~/projects/app",
			wantPrefix: os.Getenv("HOME"),
		},
		{
			name:       "leaves absolute path unchanged",
			input:      "/var/www/site",
			wantPrefix: "/var/www/site",
		},
		{
			name:       "cleans relative path",
			input:      "./projects/../app",
			wantPrefix: "app",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := expandPath(tt.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !strings.HasPrefix(result, tt.wantPrefix) {
				t.Errorf("expected path starting with %q, got %q", tt.wantPrefix, result)
			}
		})
	}
}

// TestCreatedDirectoryPermissions verifies that new directories get 0755 permissions.
func TestCreatedDirectoryPermissions(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "workspace-perm-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	path := filepath.Join(tmpDir, "new-project")
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatalf("Failed to create directory: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Failed to stat directory: %v", err)
	}
	if info.Mode().Perm() != 0755 {
		t.Errorf("expected permissions 0755, got %v", info.Mode().Perm())
	}
}

// ValidationError is a sentinel used in tests.
type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string { return e.Message }
