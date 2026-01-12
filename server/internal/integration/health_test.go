package integration

import (
	"net/http"
	"testing"

)

func TestHealthEndpoint(t *testing.T) {
	ts := NewTestServer(t)

	resp, err := http.Get(ts.Server.URL + "/health")
	if err != nil {
		t.Fatalf("Failed to get health: %v", err)
	}
	defer resp.Body.Close()

	AssertStatus(t, resp, http.StatusOK)

	var result map[string]string
	ParseJSON(t, resp, &result)

	if result["status"] != "ok" {
		t.Errorf("Expected status 'ok', got '%s'", result["status"])
	}
}
