package service

import (
	"context"
	"fmt"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/store"
)

// UserPreference represents a user preference (for API responses)
type UserPreference struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// PreferenceService handles user preference operations
type PreferenceService struct {
	store *store.Store
}

// NewPreferenceService creates a new preference service
func NewPreferenceService(s *store.Store) *PreferenceService {
	return &PreferenceService{store: s}
}

// ListPreferences returns all preferences for a user
func (s *PreferenceService) ListPreferences(ctx context.Context, userID string) ([]*UserPreference, error) {
	dbPrefs, err := s.store.ListUserPreferences(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list preferences: %w", err)
	}

	prefs := make([]*UserPreference, len(dbPrefs))
	for i, p := range dbPrefs {
		prefs[i] = s.mapPreference(p)
	}
	return prefs, nil
}

// GetPreference returns a single preference by key
func (s *PreferenceService) GetPreference(ctx context.Context, userID, key string) (*UserPreference, error) {
	p, err := s.store.GetUserPreference(ctx, userID, key)
	if err != nil {
		return nil, fmt.Errorf("failed to get preference: %w", err)
	}
	return s.mapPreference(p), nil
}

// SetPreference creates or updates a preference
func (s *PreferenceService) SetPreference(ctx context.Context, userID, key, value string) (*UserPreference, error) {
	pref := &model.UserPreference{
		UserID: userID,
		Key:    key,
		Value:  value,
	}
	if err := s.store.SetUserPreference(ctx, pref); err != nil {
		return nil, fmt.Errorf("failed to set preference: %w", err)
	}
	return s.mapPreference(pref), nil
}

// DeletePreference deletes a preference by key
func (s *PreferenceService) DeletePreference(ctx context.Context, userID, key string) error {
	return s.store.DeleteUserPreference(ctx, userID, key)
}

// mapPreference maps a model UserPreference to a service UserPreference
func (s *PreferenceService) mapPreference(p *model.UserPreference) *UserPreference {
	return &UserPreference{
		Key:       p.Key,
		Value:     p.Value,
		UpdatedAt: p.UpdatedAt.Format("2006-01-02T15:04:05Z07:00"),
	}
}
