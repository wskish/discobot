package git

import (
	"context"

	"github.com/obot-platform/discobot/server/internal/store"
)

// StoreWorkspaceSource implements WorkspaceSource using the store.
type StoreWorkspaceSource struct {
	store *store.Store
}

// NewStoreWorkspaceSource creates a new store-backed workspace source.
func NewStoreWorkspaceSource(s *store.Store) *StoreWorkspaceSource {
	return &StoreWorkspaceSource{store: s}
}

// GetWorkspaceInfo returns workspace information from the store.
func (s *StoreWorkspaceSource) GetWorkspaceInfo(ctx context.Context, workspaceID string) (*WorkspaceInfo, error) {
	ws, err := s.store.GetWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	return &WorkspaceInfo{
		WorkspaceID: ws.ID,
		ProjectID:   ws.ProjectID,
		Path:        ws.Path,
		SourceType:  ws.SourceType,
	}, nil
}
