package service

import (
	"context"
	"fmt"

	"github.com/anthropics/octobot/server/internal/git"
	"github.com/anthropics/octobot/server/internal/store"
)

// GitService provides git operations for workspaces.
// It wraps a git.Provider and integrates with the workspace store.
type GitService struct {
	store    *store.Store
	provider git.Provider
}

// NewGitService creates a new git service.
func NewGitService(s *store.Store, provider git.Provider) *GitService {
	return &GitService{
		store:    s,
		provider: provider,
	}
}

// EnsureWorkspaceRepo ensures the workspace's repository is set up.
// For git-sourced workspaces, this clones/fetches the repo.
// For local workspaces, this validates the path.
func (s *GitService) EnsureWorkspaceRepo(ctx context.Context, workspaceID string) (string, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return "", fmt.Errorf("workspace not found: %w", err)
	}

	// Use Path as source - could be a git URL or local path
	return s.provider.EnsureWorkspace(ctx, workspaceID, ws.Path, "")
}

// EnsureWorkspaceRepoAtRef ensures the workspace's repository at a specific ref.
func (s *GitService) EnsureWorkspaceRepoAtRef(ctx context.Context, workspaceID, ref string) (string, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return "", fmt.Errorf("workspace not found: %w", err)
	}

	return s.provider.EnsureWorkspace(ctx, workspaceID, ws.Path, ref)
}

// Fetch fetches updates from remote for a workspace.
func (s *GitService) Fetch(ctx context.Context, workspaceID string) error {
	return s.provider.Fetch(ctx, workspaceID)
}

// Checkout checks out a specific ref in the workspace.
func (s *GitService) Checkout(ctx context.Context, workspaceID, ref string) error {
	return s.provider.Checkout(ctx, workspaceID, ref)
}

// Status returns the git status for a workspace.
func (s *GitService) Status(ctx context.Context, workspaceID string) (*git.Status, error) {
	return s.provider.Status(ctx, workspaceID)
}

// Diff returns file diffs for a workspace.
func (s *GitService) Diff(ctx context.Context, workspaceID string, opts git.DiffOptions) ([]git.FileDiff, error) {
	return s.provider.Diff(ctx, workspaceID, opts)
}

// Branches returns all branches for a workspace.
func (s *GitService) Branches(ctx context.Context, workspaceID string) ([]git.Branch, error) {
	return s.provider.Branches(ctx, workspaceID)
}

// FileTree returns the file tree for a workspace at a specific ref.
func (s *GitService) FileTree(ctx context.Context, workspaceID, ref string) ([]git.FileEntry, error) {
	return s.provider.FileTree(ctx, workspaceID, ref)
}

// ReadFile reads a file from a workspace.
// If ref is empty, reads from the working tree.
func (s *GitService) ReadFile(ctx context.Context, workspaceID, ref, path string) ([]byte, error) {
	return s.provider.ReadFile(ctx, workspaceID, ref, path)
}

// WriteFile writes content to a file in the workspace's working tree.
func (s *GitService) WriteFile(ctx context.Context, workspaceID, path string, content []byte) error {
	return s.provider.WriteFile(ctx, workspaceID, path, content)
}

// Stage stages files for commit.
func (s *GitService) Stage(ctx context.Context, workspaceID string, paths []string) error {
	return s.provider.Stage(ctx, workspaceID, paths)
}

// Commit creates a commit in the workspace.
func (s *GitService) Commit(ctx context.Context, workspaceID, message, authorName, authorEmail string) (*git.Commit, error) {
	return s.provider.Commit(ctx, workspaceID, message, authorName, authorEmail)
}

// Log returns commit history for a workspace.
func (s *GitService) Log(ctx context.Context, workspaceID string, opts git.LogOptions) ([]git.Commit, error) {
	return s.provider.Log(ctx, workspaceID, opts)
}

// GetWorkDir returns the working directory for a workspace.
func (s *GitService) GetWorkDir(ctx context.Context, workspaceID string) string {
	return s.provider.GetWorkDir(ctx, workspaceID)
}

// RemoveWorkspace cleans up the workspace's git working directory.
func (s *GitService) RemoveWorkspace(ctx context.Context, workspaceID string) error {
	return s.provider.RemoveWorkspace(ctx, workspaceID)
}

// Provider returns the underlying git provider.
// This allows direct access for advanced operations.
func (s *GitService) Provider() git.Provider {
	return s.provider
}
