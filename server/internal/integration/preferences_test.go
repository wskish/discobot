package integration

import (
	"net/http"
	"testing"
)

func TestListPreferences_Empty(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/preferences")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Preferences []interface{} `json:"preferences"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Preferences) != 0 {
		t.Errorf("Expected 0 preferences, got %d", len(result.Preferences))
	}
}

func TestSetPreference(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/preferences/preferredIDE", map[string]interface{}{
		"value": "vscode",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["key"] != "preferredIDE" {
		t.Errorf("Expected key 'preferredIDE', got '%v'", pref["key"])
	}
	if pref["value"] != "vscode" {
		t.Errorf("Expected value 'vscode', got '%v'", pref["value"])
	}
}

func TestGetPreference(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// First set a preference
	resp := client.Put("/api/preferences/theme", map[string]interface{}{
		"value": "dark",
	})
	resp.Body.Close()
	AssertStatus(t, resp, http.StatusOK)

	// Then get it
	resp = client.Get("/api/preferences/theme")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["key"] != "theme" {
		t.Errorf("Expected key 'theme', got '%v'", pref["key"])
	}
	if pref["value"] != "dark" {
		t.Errorf("Expected value 'dark', got '%v'", pref["value"])
	}
}

func TestGetPreference_NotFound(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/api/preferences/nonexistent")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
}

func TestUpdatePreference(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Set initial value
	resp := client.Put("/api/preferences/editor", map[string]interface{}{
		"value": "vim",
	})
	resp.Body.Close()
	AssertStatus(t, resp, http.StatusOK)

	// Update it
	resp = client.Put("/api/preferences/editor", map[string]interface{}{
		"value": "neovim",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["value"] != "neovim" {
		t.Errorf("Expected value 'neovim', got '%v'", pref["value"])
	}
}

func TestDeletePreference(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Set a preference
	resp := client.Put("/api/preferences/toDelete", map[string]interface{}{
		"value": "some-value",
	})
	resp.Body.Close()
	AssertStatus(t, resp, http.StatusOK)

	// Delete it
	resp = client.Delete("/api/preferences/toDelete")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	// Verify it's gone
	resp = client.Get("/api/preferences/toDelete")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
}

func TestDeletePreference_NotFound(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Delete("/api/preferences/nonexistent")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusNotFound)
}

func TestSetMultiplePreferences(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Put("/api/preferences", map[string]interface{}{
		"preferences": map[string]string{
			"theme":  "dark",
			"editor": "cursor",
			"font":   "JetBrains Mono",
		},
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Preferences []map[string]interface{} `json:"preferences"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Preferences) != 3 {
		t.Errorf("Expected 3 preferences, got %d", len(result.Preferences))
	}
}

func TestListPreferences_WithData(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Set multiple preferences
	client.Put("/api/preferences/pref1", map[string]interface{}{"value": "val1"}).Body.Close()
	client.Put("/api/preferences/pref2", map[string]interface{}{"value": "val2"}).Body.Close()

	// List them
	resp := client.Get("/api/preferences")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result struct {
		Preferences []map[string]interface{} `json:"preferences"`
	}
	ParseJSON(t, resp, &result)

	if len(result.Preferences) != 2 {
		t.Errorf("Expected 2 preferences, got %d", len(result.Preferences))
	}
}

func TestPreferences_UserIsolation(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user1 := ts.CreateTestUser("user1@example.com")
	user2 := ts.CreateTestUser("user2@example.com")
	client1 := ts.AuthenticatedClient(user1)
	client2 := ts.AuthenticatedClient(user2)

	// User 1 sets a preference
	resp := client1.Put("/api/preferences/myPref", map[string]interface{}{
		"value": "user1-value",
	})
	resp.Body.Close()
	AssertStatus(t, resp, http.StatusOK)

	// User 2 should not see it
	resp = client2.Get("/api/preferences/myPref")
	defer resp.Body.Close()
	AssertStatus(t, resp, http.StatusNotFound)

	// User 2 sets their own version
	resp = client2.Put("/api/preferences/myPref", map[string]interface{}{
		"value": "user2-value",
	})
	resp.Body.Close()
	AssertStatus(t, resp, http.StatusOK)

	// User 1's value should still be their own
	resp = client1.Get("/api/preferences/myPref")
	defer resp.Body.Close()

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["value"] != "user1-value" {
		t.Errorf("Expected user1's value 'user1-value', got '%v'", pref["value"])
	}
}

func TestPreferences_Unauthenticated(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)

	// Try to access without auth
	req, _ := http.NewRequest("GET", ts.Server.URL+"/api/preferences", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Request failed: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusUnauthorized)
}

func TestPreferences_SpecialCharactersInKey(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Test with a key that has special characters (URL encoded)
	resp := client.Put("/api/preferences/user.settings.theme", map[string]interface{}{
		"value": "dark",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["key"] != "user.settings.theme" {
		t.Errorf("Expected key 'user.settings.theme', got '%v'", pref["key"])
	}
}

func TestPreferences_EmptyValue(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Set a preference with empty value (should be allowed)
	resp := client.Put("/api/preferences/emptyPref", map[string]interface{}{
		"value": "",
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["value"] != "" {
		t.Errorf("Expected empty value, got '%v'", pref["value"])
	}
}

func TestPreferences_LargeValue(t *testing.T) {
	t.Parallel()
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	// Set a preference with a large JSON value
	largeValue := `{"settings": {"theme": "dark", "fontSize": 14, "fontFamily": "JetBrains Mono", "tabSize": 4, "wordWrap": true}}`
	resp := client.Put("/api/preferences/complexConfig", map[string]interface{}{
		"value": largeValue,
	})
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var pref map[string]interface{}
	ParseJSON(t, resp, &pref)

	if pref["value"] != largeValue {
		t.Errorf("Expected large value to be stored correctly")
	}
}
