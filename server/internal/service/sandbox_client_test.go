package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/obot-platform/octobot/server/internal/sandbox"
)

// mockSandboxProvider implements sandbox.Provider for testing SandboxChatClient.
// Only Get, GetSecret, and HTTPClient are used by SandboxChatClient.
type mockSandboxProvider struct {
	secret  string
	handler http.Handler // Handler for HTTPClient to use
}

func (m *mockSandboxProvider) ImageExists(_ context.Context) bool {
	return true
}

func (m *mockSandboxProvider) Image() string {
	return "test-image"
}

func (m *mockSandboxProvider) Create(_ context.Context, _ string, _ sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	return &sandbox.Sandbox{Status: sandbox.StatusCreated}, nil
}

func (m *mockSandboxProvider) Get(_ context.Context, _ string) (*sandbox.Sandbox, error) {
	return &sandbox.Sandbox{
		Status: sandbox.StatusRunning,
	}, nil
}

func (m *mockSandboxProvider) Start(_ context.Context, _ string) error {
	return nil
}

func (m *mockSandboxProvider) Stop(_ context.Context, _ string, _ time.Duration) error {
	return nil
}

func (m *mockSandboxProvider) Remove(_ context.Context, _ string) error {
	return nil
}

func (m *mockSandboxProvider) Exec(_ context.Context, _ string, _ []string, _ sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	return &sandbox.ExecResult{ExitCode: 0}, nil
}

func (m *mockSandboxProvider) Attach(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
	return nil, nil
}

func (m *mockSandboxProvider) List(_ context.Context) ([]*sandbox.Sandbox, error) {
	return nil, nil
}

func (m *mockSandboxProvider) GetSecret(_ context.Context, _ string) (string, error) {
	return m.secret, nil
}

func (m *mockSandboxProvider) HTTPClient(_ context.Context, _ string) (*http.Client, error) {
	if m.handler != nil {
		return &http.Client{Transport: &testRoundTripper{handler: m.handler}}, nil
	}
	return &http.Client{}, nil
}

// testRoundTripper implements http.RoundTripper for testing.
type testRoundTripper struct {
	handler http.Handler
}

func (t *testRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	rec := httptest.NewRecorder()
	t.handler.ServeHTTP(rec, req)
	return rec.Result(), nil
}

func (m *mockSandboxProvider) Watch(_ context.Context) (<-chan sandbox.StateEvent, error) {
	ch := make(chan sandbox.StateEvent)
	close(ch)
	return ch, nil
}

func TestSandboxChatClient_SendMessages_Returns202ThenStreams(t *testing.T) {
	// Track request sequence
	var postCalled, getCalled bool

	// Create handler that simulates agent-api behavior
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/chat" {
			postCalled = true
			// Return 202 Accepted (completion started)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{
				"completionId": "test-123",
				"status":       "started",
			})
			return
		}

		if r.Method == "GET" && r.URL.Path == "/chat" {
			getCalled = true
			// Check Accept header
			if r.Header.Get("Accept") != "text/event-stream" {
				t.Errorf("Expected Accept: text/event-stream, got %s", r.Header.Get("Accept"))
			}
			// Return SSE stream
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("data: {\"type\":\"text\"}\n\n"))
			w.Write([]byte("data: [DONE]\n\n"))
			return
		}

		t.Errorf("Unexpected request: %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	})

	// Create client with mock provider
	provider := &mockSandboxProvider{handler: handler}
	client := NewSandboxChatClient(provider)

	// Send messages
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	messages := json.RawMessage(`[{"role":"user","content":"hello"}]`)
	ch, err := client.SendMessages(ctx, "test-session", messages, nil)
	if err != nil {
		t.Fatalf("SendMessages failed: %v", err)
	}

	// Verify POST was called first, then GET
	if !postCalled {
		t.Error("POST /chat was not called")
	}
	if !getCalled {
		t.Error("GET /chat was not called after 202")
	}

	// Read SSE events
	var events []SSELine
	for line := range ch {
		events = append(events, line)
	}

	// Should have received data event and done signal
	if len(events) != 2 {
		t.Errorf("Expected 2 events, got %d", len(events))
	}
	if len(events) > 0 && events[0].Data != `{"type":"text"}` {
		t.Errorf("Expected text event, got %s", events[0].Data)
	}
	if len(events) > 1 && !events[1].Done {
		t.Error("Expected Done signal")
	}
}

func TestSandboxChatClient_SendMessages_Non202Error(t *testing.T) {
	// Create handler that returns 400 Bad Request
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/chat" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{
				"error": "messages array required",
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	provider := &mockSandboxProvider{handler: handler}
	client := NewSandboxChatClient(provider)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	messages := json.RawMessage(`[]`)
	_, err := client.SendMessages(ctx, "test-session", messages, nil)
	if err == nil {
		t.Fatal("Expected error for 400 response")
	}

	// Error message should include status code
	if !contains(err.Error(), "400") {
		t.Errorf("Expected error to contain '400', got: %s", err.Error())
	}
}

func TestSandboxChatClient_SendMessages_409Conflict(t *testing.T) {
	// Create handler that returns 409 Conflict (completion already running)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/chat" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{
				"error":        "completion_in_progress",
				"completionId": "existing-456",
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	provider := &mockSandboxProvider{handler: handler}
	client := NewSandboxChatClient(provider)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	messages := json.RawMessage(`[{"role":"user","content":"hello"}]`)
	_, err := client.SendMessages(ctx, "test-session", messages, nil)
	if err == nil {
		t.Fatal("Expected error for 409 response")
	}

	// Error message should include status code and conflict info
	if !contains(err.Error(), "409") {
		t.Errorf("Expected error to contain '409', got: %s", err.Error())
	}
}

func TestSandboxChatClient_GetStream_NoContent(t *testing.T) {
	// Create handler that returns 204 No Content (no completion running)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" && r.URL.Path == "/chat" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	provider := &mockSandboxProvider{handler: handler}
	client := NewSandboxChatClient(provider)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ch, err := client.GetStream(ctx, "test-session", nil)
	if err != nil {
		t.Fatalf("GetStream failed: %v", err)
	}

	// Channel should be closed immediately (no events)
	var count int
	for range ch {
		count++
	}
	if count != 0 {
		t.Errorf("Expected 0 events for 204, got %d", count)
	}
}

func TestSandboxChatClient_SendMessages_WithCredentials(t *testing.T) {
	var receivedCredentials string

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/chat" {
			receivedCredentials = r.Header.Get("X-Octobot-Credentials")
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{
				"completionId": "test-123",
				"status":       "started",
			})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/chat" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("data: [DONE]\n\n"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	provider := &mockSandboxProvider{handler: handler}
	client := NewSandboxChatClient(provider)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	messages := json.RawMessage(`[{"role":"user","content":"hello"}]`)
	opts := &RequestOptions{
		Credentials: []CredentialEnvVar{
			{EnvVar: "API_KEY", Value: "secret123"},
		},
	}

	ch, err := client.SendMessages(ctx, "test-session", messages, opts)
	if err != nil {
		t.Fatalf("SendMessages failed: %v", err)
	}

	// Drain channel to completion
	for range ch { //nolint:revive // empty block intentionally drains channel
	}

	// Verify credentials were sent
	if receivedCredentials == "" {
		t.Error("Expected credentials header to be set")
	}
	if !contains(receivedCredentials, "API_KEY") {
		t.Errorf("Expected credentials to contain API_KEY, got: %s", receivedCredentials)
	}
}

func TestSandboxChatClient_SendMessages_WithAuthorization(t *testing.T) {
	var receivedAuth string

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/chat" {
			receivedAuth = r.Header.Get("Authorization")
			w.WriteHeader(http.StatusAccepted)
			json.NewEncoder(w).Encode(map[string]string{
				"completionId": "test-123",
				"status":       "started",
			})
			return
		}
		if r.Method == "GET" && r.URL.Path == "/chat" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte("data: [DONE]\n\n"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	provider := &mockSandboxProvider{handler: handler, secret: "my-secret-token"}
	client := NewSandboxChatClient(provider)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	messages := json.RawMessage(`[{"role":"user","content":"hello"}]`)
	ch, err := client.SendMessages(ctx, "test-session", messages, nil)
	if err != nil {
		t.Fatalf("SendMessages failed: %v", err)
	}

	// Drain channel to completion
	for range ch { //nolint:revive // empty block intentionally drains channel
	}

	// Verify authorization header was set
	expected := "Bearer my-secret-token"
	if receivedAuth != expected {
		t.Errorf("Expected Authorization: %s, got: %s", expected, receivedAuth)
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > 0 && containsHelper(s, substr))
}

func containsHelper(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
