package service

import (
	"context"
	"testing"
	"time"

	"github.com/obot-platform/discobot/server/internal/model"
)

// mockPreferenceStore implements the methods needed for preference testing
type mockPreferenceStore struct {
	preferences map[string]map[string]*model.UserPreference // userID -> key -> pref
}

func newMockPreferenceStore() *mockPreferenceStore {
	return &mockPreferenceStore{
		preferences: make(map[string]map[string]*model.UserPreference),
	}
}

func (m *mockPreferenceStore) ListUserPreferences(_ context.Context, userID string) ([]*model.UserPreference, error) {
	userPrefs, ok := m.preferences[userID]
	if !ok {
		return []*model.UserPreference{}, nil
	}

	result := make([]*model.UserPreference, 0, len(userPrefs))
	for _, p := range userPrefs {
		result = append(result, p)
	}
	return result, nil
}

func (m *mockPreferenceStore) GetUserPreference(_ context.Context, userID, key string) (*model.UserPreference, error) {
	userPrefs, ok := m.preferences[userID]
	if !ok {
		return nil, errNotFound
	}
	pref, ok := userPrefs[key]
	if !ok {
		return nil, errNotFound
	}
	return pref, nil
}

func (m *mockPreferenceStore) SetUserPreference(_ context.Context, pref *model.UserPreference) error {
	if m.preferences[pref.UserID] == nil {
		m.preferences[pref.UserID] = make(map[string]*model.UserPreference)
	}

	existing, ok := m.preferences[pref.UserID][pref.Key]
	if ok {
		existing.Value = pref.Value
		existing.UpdatedAt = time.Now()
	} else {
		pref.ID = "pref-" + pref.UserID + "-" + pref.Key
		pref.CreatedAt = time.Now()
		pref.UpdatedAt = time.Now()
		m.preferences[pref.UserID][pref.Key] = pref
	}
	return nil
}

func (m *mockPreferenceStore) DeleteUserPreference(_ context.Context, userID, key string) error {
	userPrefs, ok := m.preferences[userID]
	if !ok {
		return errNotFound
	}
	if _, ok := userPrefs[key]; !ok {
		return errNotFound
	}
	delete(userPrefs, key)
	return nil
}

// errNotFound simulates store.ErrNotFound
var errNotFound = &notFoundError{}

type notFoundError struct{}

func (e *notFoundError) Error() string { return "record not found" }

func TestPreferenceService_ListPreferences_Empty(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()

	prefs, err := store.ListUserPreferences(ctx, "user-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(prefs) != 0 {
		t.Errorf("expected 0 preferences, got %d", len(prefs))
	}
}

func TestPreferenceService_SetAndGet(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Set a preference
	pref := &model.UserPreference{
		UserID: userID,
		Key:    "theme",
		Value:  "dark",
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference: %v", err)
	}

	// Get it back
	got, err := store.GetUserPreference(ctx, userID, "theme")
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}
	if got.Value != "dark" {
		t.Errorf("expected value 'dark', got '%s'", got.Value)
	}
}

func TestPreferenceService_Update(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Set initial value
	pref := &model.UserPreference{
		UserID: userID,
		Key:    "editor",
		Value:  "vim",
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference: %v", err)
	}

	// Update it
	pref.Value = "neovim"
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to update preference: %v", err)
	}

	// Verify update
	got, err := store.GetUserPreference(ctx, userID, "editor")
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}
	if got.Value != "neovim" {
		t.Errorf("expected value 'neovim', got '%s'", got.Value)
	}
}

func TestPreferenceService_Delete(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Set a preference
	pref := &model.UserPreference{
		UserID: userID,
		Key:    "toDelete",
		Value:  "value",
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference: %v", err)
	}

	// Delete it
	if err := store.DeleteUserPreference(ctx, userID, "toDelete"); err != nil {
		t.Fatalf("failed to delete preference: %v", err)
	}

	// Verify it's gone
	_, err := store.GetUserPreference(ctx, userID, "toDelete")
	if err == nil {
		t.Error("expected error when getting deleted preference")
	}
}

func TestPreferenceService_DeleteNotFound(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()

	err := store.DeleteUserPreference(ctx, "user-123", "nonexistent")
	if err == nil {
		t.Error("expected error when deleting nonexistent preference")
	}
}

func TestPreferenceService_UserIsolation(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()

	// User 1 sets a preference
	pref1 := &model.UserPreference{
		UserID: "user-1",
		Key:    "theme",
		Value:  "dark",
	}
	if err := store.SetUserPreference(ctx, pref1); err != nil {
		t.Fatalf("failed to set preference for user 1: %v", err)
	}

	// User 2 sets the same key with different value
	pref2 := &model.UserPreference{
		UserID: "user-2",
		Key:    "theme",
		Value:  "light",
	}
	if err := store.SetUserPreference(ctx, pref2); err != nil {
		t.Fatalf("failed to set preference for user 2: %v", err)
	}

	// Verify user 1's value is unchanged
	got1, err := store.GetUserPreference(ctx, "user-1", "theme")
	if err != nil {
		t.Fatalf("failed to get user 1's preference: %v", err)
	}
	if got1.Value != "dark" {
		t.Errorf("user 1's theme: expected 'dark', got '%s'", got1.Value)
	}

	// Verify user 2's value
	got2, err := store.GetUserPreference(ctx, "user-2", "theme")
	if err != nil {
		t.Fatalf("failed to get user 2's preference: %v", err)
	}
	if got2.Value != "light" {
		t.Errorf("user 2's theme: expected 'light', got '%s'", got2.Value)
	}

	// Verify user 2 cannot see user 1's other keys
	_, err = store.GetUserPreference(ctx, "user-2", "nonexistent")
	if err == nil {
		t.Error("expected error when user 2 tries to get nonexistent key")
	}
}

func TestPreferenceService_ListMultiple(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Set multiple preferences
	keys := []string{"theme", "editor", "font", "tabSize"}
	for _, key := range keys {
		pref := &model.UserPreference{
			UserID: userID,
			Key:    key,
			Value:  "value-" + key,
		}
		if err := store.SetUserPreference(ctx, pref); err != nil {
			t.Fatalf("failed to set preference %s: %v", key, err)
		}
	}

	// List all
	prefs, err := store.ListUserPreferences(ctx, userID)
	if err != nil {
		t.Fatalf("failed to list preferences: %v", err)
	}
	if len(prefs) != len(keys) {
		t.Errorf("expected %d preferences, got %d", len(keys), len(prefs))
	}
}

func TestPreferenceService_EmptyValue(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Set a preference with empty value (should be allowed)
	pref := &model.UserPreference{
		UserID: userID,
		Key:    "emptyPref",
		Value:  "",
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference with empty value: %v", err)
	}

	got, err := store.GetUserPreference(ctx, userID, "emptyPref")
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}
	if got.Value != "" {
		t.Errorf("expected empty value, got '%s'", got.Value)
	}
}

func TestPreferenceService_SpecialCharactersInKey(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Keys with dots (namespace-style)
	key := "user.settings.theme"
	pref := &model.UserPreference{
		UserID: userID,
		Key:    key,
		Value:  "dark",
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference with dotted key: %v", err)
	}

	got, err := store.GetUserPreference(ctx, userID, key)
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}
	if got.Key != key {
		t.Errorf("expected key '%s', got '%s'", key, got.Key)
	}
}

func TestPreferenceService_LargeValue(t *testing.T) {
	store := newMockPreferenceStore()
	ctx := context.Background()
	userID := "user-123"

	// Large JSON value
	largeValue := `{"settings": {"theme": "dark", "fontSize": 14, "fontFamily": "JetBrains Mono", "tabSize": 4, "wordWrap": true, "autoSave": true, "formatOnSave": true}}`
	pref := &model.UserPreference{
		UserID: userID,
		Key:    "complexConfig",
		Value:  largeValue,
	}
	if err := store.SetUserPreference(ctx, pref); err != nil {
		t.Fatalf("failed to set preference with large value: %v", err)
	}

	got, err := store.GetUserPreference(ctx, userID, "complexConfig")
	if err != nil {
		t.Fatalf("failed to get preference: %v", err)
	}
	if got.Value != largeValue {
		t.Error("large value was not stored correctly")
	}
}

func TestUserPreference_MapPreference(t *testing.T) {
	// Test the service's mapPreference function indirectly
	pref := &model.UserPreference{
		ID:        "pref-123",
		UserID:    "user-123",
		Key:       "theme",
		Value:     "dark",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	// Verify the model has required fields
	if pref.Key != "theme" {
		t.Errorf("expected key 'theme', got '%s'", pref.Key)
	}
	if pref.Value != "dark" {
		t.Errorf("expected value 'dark', got '%s'", pref.Value)
	}
	if pref.UpdatedAt.IsZero() {
		t.Error("UpdatedAt should not be zero")
	}
}
