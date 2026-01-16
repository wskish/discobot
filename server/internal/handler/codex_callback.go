package handler

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/obot-platform/octobot/server/internal/oauth"
	"github.com/obot-platform/octobot/server/internal/service"
)

const (
	codexCallbackPort = 1455
	codexCallbackAddr = "127.0.0.1:1455"
)

// pendingCodexAuth stores pending OAuth sessions
type pendingCodexAuth struct {
	state       string
	verifier    string
	projectID   string
	redirectURI string
	createdAt   time.Time
}

// CodexCallbackServer handles the OAuth callback on localhost:1455
type CodexCallbackServer struct {
	handler       *Handler
	server        *http.Server
	listener      net.Listener
	mu            sync.Mutex
	pending       map[string]*pendingCodexAuth // state -> auth info
	running       bool
	cleanupTicker *time.Ticker
	cleanupDone   chan struct{}
}

// NewCodexCallbackServer creates a new callback server
func NewCodexCallbackServer(h *Handler) *CodexCallbackServer {
	return &CodexCallbackServer{
		handler: h,
		pending: make(map[string]*pendingCodexAuth),
	}
}

// Start attempts to start the callback server. Returns true if started successfully.
func (s *CodexCallbackServer) Start() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.running {
		return true
	}

	// Try to listen on the port
	listener, err := net.Listen("tcp", codexCallbackAddr)
	if err != nil {
		log.Printf("Codex callback server: could not listen on %s: %v (manual code entry will be required)", codexCallbackAddr, err)
		return false
	}

	s.listener = listener

	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", s.handleCallback)

	s.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// Start cleanup goroutine
	s.cleanupTicker = time.NewTicker(1 * time.Minute)
	s.cleanupDone = make(chan struct{})
	go s.cleanupExpired()

	// Start server in goroutine
	go func() {
		log.Printf("Codex callback server listening on %s", codexCallbackAddr)
		if err := s.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("Codex callback server error: %v", err)
		}
	}()

	s.running = true
	return true
}

// Stop stops the callback server
func (s *CodexCallbackServer) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return
	}

	if s.cleanupTicker != nil {
		s.cleanupTicker.Stop()
		close(s.cleanupDone)
	}

	if s.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.server.Shutdown(ctx)
	}

	s.running = false
	log.Printf("Codex callback server stopped")
}

// RegisterPending registers a pending OAuth session
func (s *CodexCallbackServer) RegisterPending(state, verifier, projectID, redirectURI string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.pending[state] = &pendingCodexAuth{
		state:       state,
		verifier:    verifier,
		projectID:   projectID,
		redirectURI: redirectURI,
		createdAt:   time.Now(),
	}
}

// cleanupExpired removes expired pending sessions (older than 10 minutes)
func (s *CodexCallbackServer) cleanupExpired() {
	for {
		select {
		case <-s.cleanupTicker.C:
			s.mu.Lock()
			cutoff := time.Now().Add(-10 * time.Minute)
			for state, auth := range s.pending {
				if auth.createdAt.Before(cutoff) {
					delete(s.pending, state)
				}
			}
			s.mu.Unlock()
		case <-s.cleanupDone:
			return
		}
	}
}

// handleCallback handles the OAuth callback
func (s *CodexCallbackServer) handleCallback(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	errorParam := r.URL.Query().Get("error")
	errorDesc := r.URL.Query().Get("error_description")

	if errorParam != "" {
		s.renderError(w, fmt.Sprintf("Authorization failed: %s - %s", errorParam, errorDesc))
		return
	}

	if code == "" {
		s.renderError(w, "No authorization code received")
		return
	}

	if state == "" {
		s.renderError(w, "No state parameter received")
		return
	}

	// Look up pending auth
	s.mu.Lock()
	auth, ok := s.pending[state]
	if ok {
		delete(s.pending, state)
	}
	s.mu.Unlock()

	if !ok {
		// State not found - show the code for manual entry
		s.renderCodeForCopy(w, code)
		return
	}

	// Exchange code for tokens
	provider := oauth.NewCodexProvider(s.handler.cfg.CodexClientID)
	tokenResp, err := provider.Exchange(r.Context(), code, auth.redirectURI, auth.verifier)
	if err != nil {
		s.renderError(w, fmt.Sprintf("Token exchange failed: %v", err))
		return
	}

	// Store the tokens
	oauthCred := &service.OAuthCredential{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		TokenType:    tokenResp.TokenType,
		ExpiresAt:    tokenResp.ExpiresAt,
		Scope:        tokenResp.Scope,
	}

	_, err = s.handler.credentialService.SetOAuthTokens(r.Context(), auth.projectID, service.ProviderCodex, "OpenAI Codex", oauthCred)
	if err != nil {
		s.renderError(w, fmt.Sprintf("Failed to store credential: %v", err))
		return
	}

	s.renderSuccess(w)
}

func (s *CodexCallbackServer) renderSuccess(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprint(w, `<!DOCTYPE html>
<html>
<head>
    <title>Authorization Successful</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        h1 { color: #22c55e; margin-bottom: 1rem; }
        p { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✓ Authorization Successful!</h1>
        <p>You can close this window and return to Octobot.</p>
        <p>Your ChatGPT credentials have been saved.</p>
    </div>
</body>
</html>`)
}

func (s *CodexCallbackServer) renderError(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
    <title>Authorization Failed</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; }
        h1 { color: #ef4444; margin-bottom: 1rem; }
        p { color: #666; }
        .error { background: #fef2f2; color: #dc2626; padding: 1rem; border-radius: 4px; margin: 1rem 0; word-break: break-word; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Authorization Failed</h1>
        <div class="error">%s</div>
        <p>Please close this window and try again.</p>
    </div>
</body>
</html>`, message)
}

func (s *CodexCallbackServer) renderCodeForCopy(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = fmt.Fprintf(w, `<!DOCTYPE html>
<html>
<head>
    <title>Authorization Code</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; }
        h1 { color: #22c55e; margin-bottom: 1rem; }
        p { color: #666; }
        .code { background: #f0f0f0; padding: 1rem; border-radius: 4px; font-family: monospace; word-break: break-all; margin: 1rem 0; position: relative; }
        button { background: #3b82f6; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin-top: 0.5rem; }
        button:hover { background: #2563eb; }
    </style>
    <script>
        function copyCode() {
            navigator.clipboard.writeText('%s');
            document.getElementById('copyBtn').textContent = 'Copied!';
            setTimeout(() => document.getElementById('copyBtn').textContent = 'Copy Code', 2000);
        }
    </script>
</head>
<body>
    <div class="container">
        <h1>Authorization Code</h1>
        <p>Copy this code and paste it in Octobot:</p>
        <div class="code">%s</div>
        <button id="copyBtn" onclick="copyCode()">Copy Code</button>
        <p style="margin-top: 1rem; font-size: 0.875rem;">You can close this window after copying.</p>
    </div>
</body>
</html>`, code, code)
}
