package service

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// Workspace represents a workspace with its sessions (for API responses)
type Workspace struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Path       string     `json:"path"`
	SourceType string     `json:"sourceType"`
	Sessions   []*Session `json:"sessions"`
}

// WorkspaceService handles workspace operations
type WorkspaceService struct {
	store *store.Store
}

// NewWorkspaceService creates a new workspace service
func NewWorkspaceService(s *store.Store) *WorkspaceService {
	return &WorkspaceService{store: s}
}

// ListWorkspaces returns all workspaces for a project
func (s *WorkspaceService) ListWorkspaces(ctx context.Context, projectID string) ([]*Workspace, error) {
	dbWorkspaces, err := s.store.ListWorkspacesByProject(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to list workspaces: %w", err)
	}

	workspaces := make([]*Workspace, len(dbWorkspaces))
	for i, ws := range dbWorkspaces {
		workspaces[i] = &Workspace{
			ID:         ws.ID,
			Name:       ws.Name,
			Path:       ws.Path,
			SourceType: ws.SourceType,
			Sessions:   []*Session{}, // Sessions fetched separately if needed
		}
	}
	return workspaces, nil
}

// GetWorkspace returns a single workspace by ID
func (s *WorkspaceService) GetWorkspace(ctx context.Context, workspaceID string) (*Workspace, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}

	return &Workspace{
		ID:         ws.ID,
		Name:       ws.Name,
		Path:       ws.Path,
		SourceType: ws.SourceType,
		Sessions:   []*Session{},
	}, nil
}

// CreateWorkspace creates a new workspace
func (s *WorkspaceService) CreateWorkspace(ctx context.Context, projectID, path, sourceType string) (*Workspace, error) {
	// Derive name from path
	name := filepath.Base(path)
	if name == "" || name == "." || name == "/" {
		name = path
	}

	ws := &model.Workspace{
		ProjectID:  projectID,
		Name:       name,
		Path:       path,
		SourceType: sourceType,
	}
	if err := s.store.CreateWorkspace(ctx, ws); err != nil {
		return nil, fmt.Errorf("failed to create workspace: %w", err)
	}

	return &Workspace{
		ID:         ws.ID,
		Name:       ws.Name,
		Path:       ws.Path,
		SourceType: ws.SourceType,
		Sessions:   []*Session{},
	}, nil
}

// UpdateWorkspace updates a workspace
func (s *WorkspaceService) UpdateWorkspace(ctx context.Context, workspaceID, name, path string) (*Workspace, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}

	ws.Name = name
	ws.Path = path
	if err := s.store.UpdateWorkspace(ctx, ws); err != nil {
		return nil, fmt.Errorf("failed to update workspace: %w", err)
	}

	return &Workspace{
		ID:         ws.ID,
		Name:       ws.Name,
		Path:       ws.Path,
		SourceType: ws.SourceType,
		Sessions:   []*Session{},
	}, nil
}

// DeleteWorkspace deletes a workspace
func (s *WorkspaceService) DeleteWorkspace(ctx context.Context, workspaceID string) error {
	return s.store.DeleteWorkspace(ctx, workspaceID)
}

// GetWorkspaceWithSessions returns a workspace with all its sessions
func (s *WorkspaceService) GetWorkspaceWithSessions(ctx context.Context, workspaceID string) (*Workspace, error) {
	workspace, err := s.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	// Create session service to fetch sessions
	sessionSvc := NewSessionService(s.store)
	sessions, err := sessionSvc.ListSessionsByWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}

	workspace.Sessions = sessions
	return workspace, nil
}
