package integration

import (
	"net/http"
	"testing"

	"github.com/anthropics/octobot/server/internal/model"
)

func TestAuthMe_Unauthenticated(t *testing.T) {
	ts := NewTestServer(t)

	resp, err := http.Get(ts.Server.URL + "/auth/me")
	if err != nil {
		t.Fatalf("Failed to call /auth/me: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusUnauthorized)
}

func TestAuthMe_Authenticated(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Get("/auth/me")
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["email"] != "test@example.com" {
		t.Errorf("Expected email 'test@example.com', got '%v'", result["email"])
	}
}

func TestAuthLogout(t *testing.T) {
	ts := NewTestServer(t)
	user := ts.CreateTestUser("test@example.com")
	client := ts.AuthenticatedClient(user)

	resp := client.Post("/auth/logout", nil)
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]bool
	ParseJSON(t, resp, &result)

	if !result["success"] {
		t.Error("Expected success to be true")
	}
}

func TestAuthLogin_UnsupportedProvider(t *testing.T) {
	ts := NewTestServer(t)

	client := ts.Client()
	resp, err := client.Get(ts.Server.URL + "/auth/login/unsupported")
	if err != nil {
		t.Fatalf("Failed to call auth login: %v", err)
	}
	defer resp.Body.Close()

	// Should return error for unsupported provider
	AssertStatus(t, resp, http.StatusBadRequest)
}

func TestNoAuthMode_AuthMe(t *testing.T) {
	ts := NewTestServerNoAuth(t)

	// In no-auth mode, /auth/me should return the anonymous user
	resp, err := http.Get(ts.Server.URL + "/auth/me")
	if err != nil {
		t.Fatalf("Failed to call /auth/me: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]interface{}
	ParseJSON(t, resp, &result)

	if result["id"] != model.AnonymousUserID {
		t.Errorf("Expected anonymous user ID '%s', got '%v'", model.AnonymousUserID, result["id"])
	}
	if result["email"] != model.AnonymousUserEmail {
		t.Errorf("Expected email '%s', got '%v'", model.AnonymousUserEmail, result["email"])
	}
}

func TestNoAuthMode_APIAccess(t *testing.T) {
	ts := NewTestServerNoAuth(t)

	// In no-auth mode, API should be accessible without authentication
	// and should use the default project for the anonymous user
	resp, err := http.Get(ts.Server.URL + "/api/projects/" + model.DefaultProjectID + "/agents/types")
	if err != nil {
		t.Fatalf("Failed to call API: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var types []map[string]interface{}
	ParseJSON(t, resp, &types)

	if len(types) == 0 {
		t.Error("Expected at least one agent type")
	}
}
