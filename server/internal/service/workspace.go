package service

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/obot-platform/octobot/server/internal/events"
	"github.com/obot-platform/octobot/server/internal/git"
	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/store"
)

// expandPath expands ~ to the user's home directory and cleans the path.
// For paths starting with ~, it replaces ~ with $HOME.
// All paths are cleaned using filepath.Clean to remove redundant elements.
func expandPath(path string) (string, error) {
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("failed to get home directory: %w", err)
		}
		path = filepath.Join(home, path[1:])
	}
	return filepath.Clean(path), nil
}

// Workspace represents a workspace with its sessions (for API responses)
type Workspace struct {
	ID           string     `json:"id"`
	Path         string     `json:"path"`
	SourceType   string     `json:"sourceType"`
	Status       string     `json:"status"`
	ErrorMessage string     `json:"errorMessage,omitempty"`
	Commit       string     `json:"commit,omitempty"`
	WorkDir      string     `json:"workDir,omitempty"`
	Sessions     []*Session `json:"sessions"`
}

// WorkspaceService handles workspace operations
type WorkspaceService struct {
	store       *store.Store
	gitProvider git.Provider
	eventBroker *events.Broker
}

// NewWorkspaceService creates a new workspace service
func NewWorkspaceService(s *store.Store, gitProvider git.Provider, eventBroker *events.Broker) *WorkspaceService {
	return &WorkspaceService{
		store:       s,
		gitProvider: gitProvider,
		eventBroker: eventBroker,
	}
}

// ListWorkspaces returns all workspaces for a project
func (s *WorkspaceService) ListWorkspaces(ctx context.Context, projectID string) ([]*Workspace, error) {
	dbWorkspaces, err := s.store.ListWorkspacesByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list workspaces: %w", err)
	}

	workspaces := make([]*Workspace, len(dbWorkspaces))
	for i, ws := range dbWorkspaces {
		workspaces[i] = s.mapWorkspace(ctx, ws)
	}
	return workspaces, nil
}

// GetWorkspace returns a single workspace by ID
func (s *WorkspaceService) GetWorkspace(ctx context.Context, workspaceID string) (*Workspace, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}

	return s.mapWorkspace(ctx, ws), nil
}

// CreateWorkspace creates a new workspace with initializing status
func (s *WorkspaceService) CreateWorkspace(ctx context.Context, projectID, path, sourceType string) (*Workspace, error) {
	// Expand ~ to home directory for local paths
	if sourceType == "local" {
		expandedPath, err := expandPath(path)
		if err != nil {
			return nil, fmt.Errorf("failed to expand path: %w", err)
		}
		path = expandedPath
	}

	ws := &model.Workspace{
		ProjectID:  projectID,
		Path:       path,
		SourceType: sourceType,
		Status:     model.WorkspaceStatusInitializing,
	}
	if err := s.store.CreateWorkspace(ctx, ws); err != nil {
		return nil, fmt.Errorf("failed to create workspace: %w", err)
	}

	return s.mapWorkspace(ctx, ws), nil
}

// UpdateWorkspace updates a workspace
func (s *WorkspaceService) UpdateWorkspace(ctx context.Context, workspaceID, path string) (*Workspace, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}

	// Expand ~ to home directory for local paths
	if ws.SourceType == "local" {
		expandedPath, err := expandPath(path)
		if err != nil {
			return nil, fmt.Errorf("failed to expand path: %w", err)
		}
		path = expandedPath
	}

	ws.Path = path
	if err := s.store.UpdateWorkspace(ctx, ws); err != nil {
		return nil, fmt.Errorf("failed to update workspace: %w", err)
	}

	return s.mapWorkspace(ctx, ws), nil
}

// mapWorkspace converts a model.Workspace to a service.Workspace
func (s *WorkspaceService) mapWorkspace(ctx context.Context, ws *model.Workspace) *Workspace {
	result := &Workspace{
		ID:         ws.ID,
		Path:       ws.Path,
		SourceType: ws.SourceType,
		Status:     ws.Status,
		Sessions:   []*Session{},
	}
	if ws.ErrorMessage != nil {
		result.ErrorMessage = *ws.ErrorMessage
	}
	if ws.Commit != nil {
		result.Commit = *ws.Commit
	}
	// Get working directory path from git provider if available
	if s.gitProvider != nil {
		result.WorkDir = s.gitProvider.GetWorkDir(ctx, ws.ID)
	}
	return result
}

// DeleteWorkspace deletes a workspace. If deleteFiles is true, also removes the
// working directory from disk.
func (s *WorkspaceService) DeleteWorkspace(ctx context.Context, workspaceID string, deleteFiles bool) error {
	// Delete files first if requested (before removing DB record)
	if deleteFiles && s.gitProvider != nil {
		if err := s.gitProvider.RemoveWorkspace(ctx, workspaceID); err != nil {
			log.Printf("Warning: failed to remove workspace files for %s: %v", workspaceID, err)
			// Continue with DB deletion even if file deletion fails
		}
	}

	return s.store.DeleteWorkspace(ctx, workspaceID)
}

// GetWorkspaceWithSessions returns a workspace with all its sessions
func (s *WorkspaceService) GetWorkspaceWithSessions(ctx context.Context, workspaceID string) (*Workspace, error) {
	workspace, err := s.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	// Create session service to fetch sessions
	// Note: git service, credential service, and sandbox provider are nil since ListSessionsByWorkspace doesn't need them
	sessionSvc := NewSessionService(s.store, nil, nil, nil, s.eventBroker)
	sessions, err := sessionSvc.ListSessionsByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	workspace.Sessions = sessions
	return workspace, nil
}

// Initialize performs workspace initialization by setting up the git working directory.
// This is called by the dispatcher when processing a workspace_init job.
func (s *WorkspaceService) Initialize(ctx context.Context, workspaceID string) error {
	if s.gitProvider == nil {
		return fmt.Errorf("git provider not configured")
	}

	// Get workspace
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return fmt.Errorf("workspace not found: %w", err)
	}

	// Update status to cloning (for git workspaces) or initializing
	if git.IsGitURL(ws.Path) {
		s.updateStatusWithEvent(ctx, ws.ProjectID, workspaceID, model.WorkspaceStatusCloning, nil)
	}

	// Initialize the workspace (clone/setup git repo)
	_, commit, err := s.gitProvider.EnsureWorkspace(ctx, ws.ProjectID, workspaceID, ws.Path, "")
	if err != nil {
		errMsg := fmt.Sprintf("failed to initialize workspace: %v", err)
		s.updateStatusWithEvent(ctx, ws.ProjectID, workspaceID, model.WorkspaceStatusError, &errMsg)
		return fmt.Errorf("workspace initialization failed: %w", err)
	}

	// Update workspace with commit and ready status
	ws.Commit = &commit
	ws.Status = model.WorkspaceStatusReady
	ws.ErrorMessage = nil
	if err := s.store.UpdateWorkspace(ctx, ws); err != nil {
		log.Printf("Failed to update workspace %s: %v", workspaceID, err)
	}

	// Emit success event
	if s.eventBroker != nil {
		if err := s.eventBroker.PublishWorkspaceUpdated(ctx, ws.ProjectID, workspaceID, model.WorkspaceStatusReady); err != nil {
			log.Printf("Failed to publish workspace update event: %v", err)
		}
	}

	log.Printf("Workspace %s initialized successfully (commit: %s)", workspaceID, commit)
	return nil
}

// updateStatusWithEvent updates workspace status and emits an SSE event.
func (s *WorkspaceService) updateStatusWithEvent(ctx context.Context, projectID, workspaceID, status string, errorMsg *string) {
	// Update workspace in database
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		log.Printf("Failed to get workspace %s for status update: %v", workspaceID, err)
		return
	}

	ws.Status = status
	ws.ErrorMessage = errorMsg
	if err := s.store.UpdateWorkspace(ctx, ws); err != nil {
		log.Printf("Failed to update workspace %s status to %s: %v", workspaceID, status, err)
	}

	// Emit SSE event
	if s.eventBroker != nil {
		if err := s.eventBroker.PublishWorkspaceUpdated(ctx, projectID, workspaceID, status); err != nil {
			log.Printf("Failed to publish workspace update event: %v", err)
		}
	}
}
