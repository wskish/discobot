package proxyapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/obot-platform/discobot/proxy/internal/config"
	"github.com/obot-platform/discobot/proxy/internal/logger"
	"github.com/obot-platform/discobot/proxy/internal/proxy"
)

func testLogger(t *testing.T) *logger.Logger {
	t.Helper()
	log, err := logger.New(config.LoggingConfig{
		Level:  "error",
		Format: "text",
	})
	if err != nil {
		t.Fatalf("Failed to create logger: %v", err)
	}
	return log
}

func createTestProxyServer(t *testing.T) *proxy.Server {
	t.Helper()
	cfg := config.Default()
	cfg.TLS.CertDir = t.TempDir()
	log := testLogger(t)

	proxyServer, err := proxy.New(cfg, log)
	if err != nil {
		t.Fatalf("Failed to create proxy server: %v", err)
	}
	return proxyServer
}

func TestAPI_POSTConfig_HeadersOnly(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	// POST config with headers only
	cfg := config.RuntimeConfig{
		Headers: config.HeadersConfig{
			"api.example.com": config.HeaderRule{
				Set: map[string]string{
					"Authorization": "Bearer token",
				},
			},
		},
	}

	body, _ := json.Marshal(cfg)
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify headers were applied
	rules := proxyServer.GetInjector().GetRules()
	if _, ok := rules["api.example.com"]; !ok {
		t.Error("Expected header rule for api.example.com to be set")
	}
}

func TestAPI_PATCHConfig_MergeHeaders(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	// First, set initial config
	initial := config.RuntimeConfig{
		Headers: config.HeadersConfig{
			"api.example.com": config.HeaderRule{
				Set: map[string]string{
					"X-Initial": "value1",
				},
			},
		},
	}
	body, _ := json.Marshal(initial)
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	apiServer.ServeHTTP(w, req)

	// PATCH to add another domain
	patch := config.RuntimeConfig{
		Headers: config.HeadersConfig{
			"api.other.com": config.HeaderRule{
				Set: map[string]string{
					"X-Other": "value2",
				},
			},
		},
	}
	body, _ = json.Marshal(patch)
	req = httptest.NewRequest("PATCH", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify both domains are present (merge)
	rules := proxyServer.GetInjector().GetRules()
	if _, ok := rules["api.example.com"]; !ok {
		t.Error("Expected api.example.com to still be present after PATCH")
	}
	if _, ok := rules["api.other.com"]; !ok {
		t.Error("Expected api.other.com to be added by PATCH")
	}
}

func TestAPI_POSTConfig_Allowlist(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	enabled := true
	cfg := config.RuntimeConfig{
		Allowlist: &config.RuntimeAllowlistConfig{
			Enabled: &enabled,
			Domains: []string{"*.example.com"},
			IPs:     []string{"10.0.0.0/8"},
		},
	}

	body, _ := json.Marshal(cfg)
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify filter was enabled
	if !proxyServer.GetFilter().IsEnabled() {
		t.Error("Expected filter to be enabled")
	}
}

func TestAPI_POSTConfig_InvalidJSON(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestAPI_POSTConfig_InvalidDomainPattern(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	cfg := config.RuntimeConfig{
		Headers: config.HeadersConfig{
			"invalid**pattern": config.HeaderRule{
				Set: map[string]string{
					"X-Test": "value",
				},
			},
		},
	}

	body, _ := json.Marshal(cfg)
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("Expected status 400, got %d", w.Code)
	}
}

func TestAPI_MethodNotAllowed(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	// GET is not allowed on /api/config
	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("Expected status 405, got %d", w.Code)
	}
}

func TestAPI_NotFound(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	req := httptest.NewRequest("POST", "/api/nonexistent", nil)
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("Expected status 404, got %d", w.Code)
	}
}

func TestAPI_EmptyBody(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	// Empty JSON object should be valid
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader([]byte("{}")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestAPI_HealthCheck(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	// Verify response contains CA cert path
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "ok" {
		t.Errorf("Expected status 'ok', got %q", resp["status"])
	}
	if resp["ca_cert"] == "" {
		t.Error("Expected ca_cert in health response")
	}
}

func TestAPI_POSTConfig_DisableAllowlist(t *testing.T) {
	proxyServer := createTestProxyServer(t)
	log := testLogger(t)
	apiServer := New(proxyServer, log)

	// First enable the allowlist
	enabled := true
	cfg := config.RuntimeConfig{
		Allowlist: &config.RuntimeAllowlistConfig{
			Enabled: &enabled,
			Domains: []string{"example.com"},
		},
	}
	body, _ := json.Marshal(cfg)
	req := httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	apiServer.ServeHTTP(w, req)

	if !proxyServer.GetFilter().IsEnabled() {
		t.Fatal("Filter should be enabled")
	}

	// Now disable it
	enabled = false
	cfg = config.RuntimeConfig{
		Allowlist: &config.RuntimeAllowlistConfig{
			Enabled: &enabled,
		},
	}
	body, _ = json.Marshal(cfg)
	req = httptest.NewRequest("POST", "/api/config", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	apiServer.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	if proxyServer.GetFilter().IsEnabled() {
		t.Error("Filter should be disabled")
	}
}

// ServeHTTP implements http.Handler for testing
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.router.ServeHTTP(w, r)
}
