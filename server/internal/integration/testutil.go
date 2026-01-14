package integration

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/database"
	"github.com/anthropics/octobot/server/internal/dispatcher"
	"github.com/anthropics/octobot/server/internal/events"
	"github.com/anthropics/octobot/server/internal/git"
	"github.com/anthropics/octobot/server/internal/handler"
	"github.com/anthropics/octobot/server/internal/jobs"
	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/sandbox"
	"github.com/anthropics/octobot/server/internal/sandbox/mock"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/anthropics/octobot/server/internal/store"
)

// TestServer wraps a test HTTP server with helpers
type TestServer struct {
	Server          *httptest.Server
	Store           *store.Store
	Config          *config.Config
	Handler         *handler.Handler
	DB              *database.DB
	GitProvider     git.Provider
	SandboxProvider sandbox.Provider
	MockSandbox     *mock.Provider // Access to mock for test assertions
	Dispatcher      *dispatcher.Service
	EventPoller     *events.Poller
	T               *testing.T
}

// NewTestServer creates a new test server with in-memory SQLite or PostgreSQL
func NewTestServer(t *testing.T) *TestServer {
	t.Helper()

	// Determine DSN based on test configuration
	var dsn string
	var driver string

	if PostgresEnabled() {
		// Use PostgreSQL container
		dsn = PostgresDSN()
		driver = "postgres"
	} else if envDSN := os.Getenv("TEST_DATABASE_DSN"); envDSN != "" {
		// Use explicit DSN from environment
		dsn = envDSN
		if len(dsn) >= 8 && dsn[:8] == "postgres" {
			driver = "postgres"
		} else {
			driver = "sqlite"
		}
	} else {
		// Default to file-based SQLite in temp directory
		// (in-memory SQLite creates separate databases per connection,
		// which doesn't work well with the dispatcher using separate goroutines)
		dsn = fmt.Sprintf("sqlite3://%s/test.db", t.TempDir())
		driver = "sqlite"
	}

	workspaceDir := t.TempDir()
	cfg := &config.Config{
		Port:           8080,
		CORSOrigins:    []string{"*"},
		DatabaseDSN:    dsn,
		DatabaseDriver: driver,
		AuthEnabled:    true, // Enable auth for testing the full auth flow
		SessionSecret:  []byte("test-session-secret-32-bytes-long!!"),
		EncryptionKey:  []byte("01234567890123456789012345678901"), // 32 bytes
		WorkspaceDir:   workspaceDir,
	}

	db, err := database.New(cfg)
	if err != nil {
		t.Fatalf("Failed to create database: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("Failed to run migrations: %v", err)
	}

	// For PostgreSQL, clean tables before each test to ensure isolation
	if driver == "postgres" {
		cleanTables(db)
	}

	s := store.New(db.DB)

	// Create git provider
	gitProvider, err := git.NewLocalProvider(workspaceDir)
	if err != nil {
		t.Fatalf("Failed to create git provider: %v", err)
	}

	// Create mock sandbox provider
	mockSandbox := mock.NewProvider()

	// Create event poller and broker for SSE
	eventPollerCfg := events.DefaultPollerConfig()
	eventPollerCfg.PollInterval = 10 * time.Millisecond // Fast polling for tests
	eventPoller := events.NewPoller(s, eventPollerCfg)
	if err := eventPoller.Start(context.Background()); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	eventBroker := events.NewBroker(s, eventPoller)

	h := handler.New(s, cfg, gitProvider, mockSandbox, eventBroker)

	// Create and start dispatcher for job processing
	cfg.DispatcherEnabled = true
	cfg.DispatcherPollInterval = 10 * time.Millisecond // Fast polling for tests
	cfg.DispatcherHeartbeatInterval = 50 * time.Millisecond
	cfg.DispatcherHeartbeatTimeout = 500 * time.Millisecond
	cfg.DispatcherJobTimeout = 30 * time.Second
	cfg.DispatcherStaleJobTimeout = 1 * time.Minute

	workspaceSvc := service.NewWorkspaceService(s, gitProvider, eventBroker)

	sessionSvc := service.NewSessionService(s, gitProvider, mockSandbox, eventBroker, cfg.SandboxImage)

	disp := dispatcher.NewService(s, cfg)
	disp.RegisterExecutor(jobs.NewWorkspaceInitExecutor(workspaceSvc))
	disp.RegisterExecutor(jobs.NewSessionInitExecutor(sessionSvc))
	disp.Start(context.Background())

	// Wire up job queue notification for immediate execution
	h.JobQueue().SetNotifyFunc(disp.NotifyNewJob)

	r := setupRouter(s, cfg, h)
	server := httptest.NewServer(r)

	ts := &TestServer{
		Server:          server,
		Store:           s,
		Config:          cfg,
		Handler:         h,
		DB:              db,
		GitProvider:     gitProvider,
		SandboxProvider: mockSandbox,
		MockSandbox:     mockSandbox,
		Dispatcher:      disp,
		EventPoller:     eventPoller,
		T:               t,
	}

	t.Cleanup(func() {
		disp.Stop()
		eventPoller.Stop()
		server.Close()
		db.Close()
	})

	return ts
}

// setupRouter creates the router with all routes (matches main.go)
func setupRouter(s *store.Store, cfg *config.Config, h *handler.Handler) *chi.Mux {
	r := chi.NewRouter()

	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(60 * time.Second))

	// Health check
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Auth routes (no auth required)
	r.Route("/auth", func(r chi.Router) {
		r.Get("/login/{provider}", h.AuthLogin)
		r.Get("/callback/{provider}", h.AuthCallback)
		r.Post("/logout", h.AuthLogout)
		r.Get("/me", h.AuthMe)
	})

	// API routes (auth required)
	r.Route("/api", func(r chi.Router) {
		r.Use(middleware.Auth(s, cfg))

		r.Get("/projects", h.ListProjects)
		r.Post("/projects", h.CreateProject)

		r.Route("/projects/{projectId}", func(r chi.Router) {
			r.Use(middleware.ProjectMember(s))

			r.Get("/", h.GetProject)
			r.Put("/", h.UpdateProject)
			r.Delete("/", h.DeleteProject)

			r.Get("/members", h.ListProjectMembers)
			r.Delete("/members/{userId}", h.RemoveProjectMember)

			r.Post("/invitations", h.CreateInvitation)
			r.Post("/invitations/{token}/accept", h.AcceptInvitation)

			r.Route("/workspaces", func(r chi.Router) {
				r.Get("/", h.ListWorkspaces)
				r.Post("/", h.CreateWorkspace)
				r.Get("/{workspaceId}", h.GetWorkspace)
				r.Put("/{workspaceId}", h.UpdateWorkspace)
				r.Delete("/{workspaceId}", h.DeleteWorkspace)

				// Sessions within workspace (list only - creation via /chat endpoint)
				r.Get("/{workspaceId}/sessions", h.ListSessionsByWorkspace)

				// Git operations
				r.Get("/{workspaceId}/git/status", h.GetWorkspaceGitStatus)
				r.Post("/{workspaceId}/git/fetch", h.FetchWorkspace)
				r.Post("/{workspaceId}/git/checkout", h.CheckoutWorkspace)
				r.Get("/{workspaceId}/git/branches", h.GetWorkspaceBranches)
				r.Get("/{workspaceId}/git/diff", h.GetWorkspaceDiff)
				r.Get("/{workspaceId}/git/files", h.GetWorkspaceFileTree)
				r.Get("/{workspaceId}/git/file", h.GetWorkspaceFileContent)
				r.Post("/{workspaceId}/git/file", h.WriteWorkspaceFile)
				r.Post("/{workspaceId}/git/stage", h.StageWorkspaceFiles)
				r.Post("/{workspaceId}/git/commit", h.CommitWorkspace)
				r.Get("/{workspaceId}/git/log", h.GetWorkspaceLog)
			})

			r.Route("/sessions", func(r chi.Router) {
				r.Get("/{sessionId}", h.GetSession)
				r.Put("/{sessionId}", h.UpdateSession)
				r.Delete("/{sessionId}", h.DeleteSession)
				r.Get("/{sessionId}/files", h.GetSessionFiles)
				r.Get("/{sessionId}/messages", h.ListMessages)
			})

			r.Route("/agents", func(r chi.Router) {
				r.Get("/", h.ListAgents)
				r.Post("/", h.CreateAgent)
				r.Get("/types", h.GetAgentTypes)
				r.Post("/default", h.SetDefaultAgent)
				r.Get("/{agentId}", h.GetAgent)
				r.Put("/{agentId}", h.UpdateAgent)
				r.Delete("/{agentId}", h.DeleteAgent)
			})

			r.Get("/files/{fileId}", h.GetFile)
			r.Get("/suggestions", h.GetSuggestions)
			r.Get("/events", h.Events)

			r.Route("/credentials", func(r chi.Router) {
				r.Get("/", h.ListCredentials)
				r.Post("/", h.CreateCredential)
				r.Get("/{provider}", h.GetCredential)
				r.Delete("/{provider}", h.DeleteCredential)

				r.Post("/anthropic/authorize", h.AnthropicAuthorize)
				r.Post("/anthropic/exchange", h.AnthropicExchange)

				r.Post("/github-copilot/device-code", h.GitHubCopilotDeviceCode)
				r.Post("/github-copilot/poll", h.GitHubCopilotPoll)

				r.Post("/codex/authorize", h.CodexAuthorize)
				r.Post("/codex/exchange", h.CodexExchange)
			})

			// Terminal (session-specific)
			r.Get("/sessions/{sessionId}/terminal/ws", h.TerminalWebSocket)
			r.Get("/sessions/{sessionId}/terminal/history", h.GetTerminalHistory)
			r.Get("/sessions/{sessionId}/terminal/status", h.GetTerminalStatus)

			// AI Chat endpoint (streaming)
			r.Post("/chat", h.Chat)
		})
	})

	return r
}

// NewTestServerNoAuth creates a test server with auth disabled (anonymous user mode)
func NewTestServerNoAuth(t *testing.T) *TestServer {
	t.Helper()

	workspaceDir := t.TempDir()
	dbDir := t.TempDir()
	cfg := &config.Config{
		Port:           8080,
		CORSOrigins:    []string{"*"},
		DatabaseDSN:    fmt.Sprintf("sqlite3://%s/test.db", dbDir),
		DatabaseDriver: "sqlite",
		AuthEnabled:    false, // Disable auth - use anonymous user
		SessionSecret:  []byte("test-session-secret-32-bytes-long!!"),
		EncryptionKey:  []byte("01234567890123456789012345678901"),
		WorkspaceDir:   workspaceDir,
	}

	db, err := database.New(cfg)
	if err != nil {
		t.Fatalf("Failed to create database: %v", err)
	}

	if err := db.Migrate(); err != nil {
		t.Fatalf("Failed to run migrations: %v", err)
	}

	// Seed the anonymous user and default project
	if err := db.Seed(); err != nil {
		t.Fatalf("Failed to seed database: %v", err)
	}

	s := store.New(db.DB)

	// Create git provider
	gitProvider, err := git.NewLocalProvider(workspaceDir)
	if err != nil {
		t.Fatalf("Failed to create git provider: %v", err)
	}

	// Create mock sandbox provider
	mockSandbox := mock.NewProvider()

	// Create event poller and broker for SSE
	eventPollerCfg := events.DefaultPollerConfig()
	eventPollerCfg.PollInterval = 10 * time.Millisecond // Fast polling for tests
	eventPoller := events.NewPoller(s, eventPollerCfg)
	if err := eventPoller.Start(context.Background()); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	eventBroker := events.NewBroker(s, eventPoller)

	h := handler.New(s, cfg, gitProvider, mockSandbox, eventBroker)

	// Create and start dispatcher for job processing
	cfg.DispatcherEnabled = true
	cfg.DispatcherPollInterval = 10 * time.Millisecond // Fast polling for tests
	cfg.DispatcherHeartbeatInterval = 50 * time.Millisecond
	cfg.DispatcherHeartbeatTimeout = 500 * time.Millisecond
	cfg.DispatcherJobTimeout = 30 * time.Second
	cfg.DispatcherStaleJobTimeout = 1 * time.Minute

	workspaceSvc := service.NewWorkspaceService(s, gitProvider, eventBroker)

	sessionSvc := service.NewSessionService(s, gitProvider, mockSandbox, eventBroker, cfg.SandboxImage)

	disp := dispatcher.NewService(s, cfg)
	disp.RegisterExecutor(jobs.NewWorkspaceInitExecutor(workspaceSvc))
	disp.RegisterExecutor(jobs.NewSessionInitExecutor(sessionSvc))
	disp.Start(context.Background())

	// Wire up job queue notification for immediate execution
	h.JobQueue().SetNotifyFunc(disp.NotifyNewJob)

	r := setupRouter(s, cfg, h)
	server := httptest.NewServer(r)

	ts := &TestServer{
		Server:          server,
		Store:           s,
		Config:          cfg,
		Handler:         h,
		DB:              db,
		GitProvider:     gitProvider,
		SandboxProvider: mockSandbox,
		MockSandbox:     mockSandbox,
		Dispatcher:      disp,
		EventPoller:     eventPoller,
		T:               t,
	}

	t.Cleanup(func() {
		disp.Stop()
		eventPoller.Stop()
		server.Close()
		db.Close()
	})

	return ts
}

// TestUser represents a test user with session
type TestUser struct {
	User    *model.User
	Session *model.UserSession
	Token   string
}

// CreateTestUser creates a test user and returns it with a valid session
func (ts *TestServer) CreateTestUser(email string) *TestUser {
	ts.T.Helper()

	user := &model.User{
		Email:      email,
		Name:       strPtr(fmt.Sprintf("Test User %s", email)),
		Provider:   "github",
		ProviderID: fmt.Sprintf("gh_%s", email),
	}

	if err := ts.Store.CreateUser(context.Background(), user); err != nil {
		ts.T.Fatalf("Failed to create test user: %v", err)
	}

	// Generate a plain token and hash it for storage (like the auth service does)
	plainToken := fmt.Sprintf("test-token-%s-%d", email, time.Now().UnixNano())
	hash := sha256.Sum256([]byte(plainToken))
	tokenHash := hex.EncodeToString(hash[:])

	session := &model.UserSession{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(24 * time.Hour),
	}

	if err := ts.Store.CreateUserSession(context.Background(), session); err != nil {
		ts.T.Fatalf("Failed to create test session: %v", err)
	}

	return &TestUser{
		User:    user,
		Session: session,
		Token:   plainToken, // Return the plain token for use in cookies
	}
}

// CreateTestProject creates a test project with the user as owner
func (ts *TestServer) CreateTestProject(user *TestUser, name string) *model.Project {
	ts.T.Helper()

	project := &model.Project{
		Name: name,
		Slug: fmt.Sprintf("%s-%d", name, time.Now().UnixNano()),
	}

	if err := ts.Store.CreateProject(context.Background(), project); err != nil {
		ts.T.Fatalf("Failed to create test project: %v", err)
	}

	member := &model.ProjectMember{
		ProjectID: project.ID,
		UserID:    user.User.ID,
		Role:      "owner",
	}

	if err := ts.Store.CreateProjectMember(context.Background(), member); err != nil {
		ts.T.Fatalf("Failed to create project member: %v", err)
	}

	return project
}

// CreateTestWorkspace creates a test workspace
func (ts *TestServer) CreateTestWorkspace(project *model.Project, path string) *model.Workspace {
	ts.T.Helper()

	workspace := &model.Workspace{
		ProjectID:  project.ID,
		Path:       path,
		SourceType: "local",
	}

	if err := ts.Store.CreateWorkspace(context.Background(), workspace); err != nil {
		ts.T.Fatalf("Failed to create test workspace: %v", err)
	}

	return workspace
}

// CreateTestSession creates a test session
func (ts *TestServer) CreateTestSession(workspace *model.Workspace, name string) *model.Session {
	ts.T.Helper()

	session := &model.Session{
		ProjectID:   workspace.ProjectID,
		WorkspaceID: workspace.ID,
		Name:        name,
		Status:      "open",
	}

	if err := ts.Store.CreateSession(context.Background(), session); err != nil {
		ts.T.Fatalf("Failed to create test session: %v", err)
	}

	return session
}

// CreateTestAgent creates a test agent
func (ts *TestServer) CreateTestAgent(project *model.Project, name, agentType string) *model.Agent {
	ts.T.Helper()

	agent := &model.Agent{
		ProjectID: project.ID,
		Name:      name,
		AgentType: agentType,
		IsDefault: false,
	}

	if err := ts.Store.CreateAgent(context.Background(), agent); err != nil {
		ts.T.Fatalf("Failed to create test agent: %v", err)
	}

	return agent
}

// Client returns an HTTP client with cookie jar for the test server
func (ts *TestServer) Client() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{
		Jar: jar,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // Don't follow redirects
		},
	}
}

// AuthenticatedClient returns an HTTP client that sends auth cookies
func (ts *TestServer) AuthenticatedClient(user *TestUser) *TestClient {
	return &TestClient{
		ts:    ts,
		token: user.Token,
	}
}

// TestClient is a helper for making authenticated requests
type TestClient struct {
	ts    *TestServer
	token string
}

// Get makes an authenticated GET request
func (tc *TestClient) Get(path string) *http.Response {
	tc.ts.T.Helper()
	return tc.do("GET", path, nil)
}

// Post makes an authenticated POST request
func (tc *TestClient) Post(path string, body interface{}) *http.Response {
	tc.ts.T.Helper()
	return tc.do("POST", path, body)
}

// Put makes an authenticated PUT request
func (tc *TestClient) Put(path string, body interface{}) *http.Response {
	tc.ts.T.Helper()
	return tc.do("PUT", path, body)
}

// Delete makes an authenticated DELETE request
func (tc *TestClient) Delete(path string) *http.Response {
	tc.ts.T.Helper()
	return tc.do("DELETE", path, nil)
}

func (tc *TestClient) do(method, path string, body interface{}) *http.Response {
	tc.ts.T.Helper()

	var bodyReader io.Reader
	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			tc.ts.T.Fatalf("Failed to marshal request body: %v", err)
		}
		bodyReader = bytes.NewReader(jsonBody)
	}

	req, err := http.NewRequest(method, tc.ts.Server.URL+path, bodyReader)
	if err != nil {
		tc.ts.T.Fatalf("Failed to create request: %v", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{
		Name:  "octobot_session",
		Value: tc.token,
	})

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		tc.ts.T.Fatalf("Request failed: %v", err)
	}

	return resp
}

// ParseJSON parses the response body as JSON
func ParseJSON(t *testing.T, resp *http.Response, v interface{}) {
	t.Helper()
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("Failed to read response body: %v", err)
	}

	if err := json.Unmarshal(body, v); err != nil {
		t.Fatalf("Failed to parse JSON: %v\nBody: %s", err, string(body))
	}
}

// AssertStatus checks the response status code
func AssertStatus(t *testing.T, resp *http.Response, expected int) {
	t.Helper()
	if resp.StatusCode != expected {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Errorf("Expected status %d, got %d\nBody: %s", expected, resp.StatusCode, string(body))
	}
}

func strPtr(s string) *string {
	return &s
}

// cleanTables truncates all tables for test isolation (PostgreSQL only)
func cleanTables(db *database.DB) {
	// Order matters due to foreign key constraints (delete children first)
	tables := []string{
		"terminal_history",
		"messages",
		"sessions",
		"workspaces",
		"agent_mcp_servers",
		"agents",
		"credentials",
		"project_invitations",
		"project_members",
		"projects",
		"user_sessions",
		"users",
	}

	for _, table := range tables {
		db.Exec("TRUNCATE TABLE " + table + " CASCADE")
	}
}
