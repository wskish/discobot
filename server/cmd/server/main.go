package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/joho/godotenv"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/container"
	"github.com/anthropics/octobot/server/internal/container/docker"
	"github.com/anthropics/octobot/server/internal/database"
	"github.com/anthropics/octobot/server/internal/dispatcher"
	"github.com/anthropics/octobot/server/internal/events"
	"github.com/anthropics/octobot/server/internal/git"
	"github.com/anthropics/octobot/server/internal/handler"
	"github.com/anthropics/octobot/server/internal/jobs"
	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/anthropics/octobot/server/internal/store"
	"github.com/anthropics/octobot/server/static"
)

func main() {
	// Load .env file if present
	_ = godotenv.Load()

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load configuration: %v", err)
	}

	// Connect to database
	db, err := database.New(cfg)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()

	// Run migrations
	log.Println("Running database migrations...")
	if err := db.Migrate(); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}
	log.Println("Migrations completed successfully")

	// Seed database with anonymous user and default project
	if err := db.Seed(); err != nil {
		log.Fatalf("Failed to seed database: %v", err)
	}

	// Log auth mode
	if cfg.AuthEnabled {
		log.Println("Authentication enabled - users must log in")
	} else {
		log.Println("Authentication disabled - using anonymous user mode")
	}

	// Create store
	s := store.New(db.DB)

	// Initialize git provider (required)
	gitProvider, err := git.NewLocalProvider(cfg.WorkspaceDir)
	if err != nil {
		log.Fatalf("Failed to initialize git provider: %v", err)
	}
	log.Printf("Git provider initialized at %s", cfg.WorkspaceDir)

	// Initialize container runtime (currently only Docker is supported)
	var containerRuntime container.Runtime
	if dockerRuntime, dockerErr := docker.NewProvider(cfg); dockerErr != nil {
		log.Printf("Warning: Failed to initialize Docker runtime: %v", dockerErr)
		log.Println("Terminal/container operations will not be available")
	} else {
		containerRuntime = dockerRuntime
		log.Printf("Container runtime initialized (type: docker)")

		// Reconcile containers on startup to ensure they use the correct image
		containerSvc := service.NewContainerService(s, containerRuntime, cfg)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		if err := containerSvc.ReconcileContainers(ctx); err != nil {
			log.Printf("Warning: Failed to reconcile containers: %v", err)
		}
		cancel()
	}

	// Create event poller and broker for SSE
	eventPoller := events.NewPoller(s, events.DefaultPollerConfig())
	if err := eventPoller.Start(context.Background()); err != nil {
		log.Fatalf("Failed to start event poller: %v", err)
	}
	eventBroker := events.NewBroker(s, eventPoller)

	// Initialize and start job dispatcher
	var disp *dispatcher.Service
	if cfg.DispatcherEnabled {
		disp = dispatcher.NewService(s, cfg)

		// Register workspace init executor
		workspaceSvc := service.NewWorkspaceService(s, gitProvider, eventBroker)
		disp.RegisterExecutor(jobs.NewWorkspaceInitExecutor(workspaceSvc))

		// Register session init executor if container runtime is available
		if containerRuntime != nil {
			sessionSvc := service.NewSessionService(s, gitProvider, containerRuntime, eventBroker, cfg.ContainerImage)
			disp.RegisterExecutor(jobs.NewSessionInitExecutor(sessionSvc))
		}

		disp.Start(context.Background())
		log.Printf("Job dispatcher started (server ID: %s)", disp.ServerID())
	} else {
		log.Println("Job dispatcher disabled")
	}

	// Create router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(chimiddleware.Timeout(60 * time.Second))

	// CORS configuration
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type", "X-CSRF-Token"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check endpoint
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	// API UI - serve the embedded static HTML file
	r.Get("/api/ui", func(w http.ResponseWriter, _ *http.Request) {
		content, err := static.Files.ReadFile("api-ui.html")
		if err != nil {
			http.Error(w, "API UI not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(content)
	})

	// Initialize handlers
	h := handler.New(s, cfg, gitProvider, containerRuntime, eventBroker)

	// Wire up job queue notification to dispatcher for immediate execution
	if disp != nil {
		h.JobQueue().SetNotifyFunc(disp.NotifyNewJob)
	}

	// System status endpoint (checks for required dependencies, no auth required)
	r.Get("/api/status", h.GetSystemStatus)

	// Auth routes (no auth required)
	r.Route("/auth", func(r chi.Router) {
		r.Get("/login/{provider}", h.AuthLogin)
		r.Get("/callback/{provider}", h.AuthCallback)
		r.Post("/logout", h.AuthLogout)
		r.Get("/me", h.AuthMe)
	})

	// API routes (auth required)
	r.Route("/api", func(r chi.Router) {
		// Auth middleware
		r.Use(middleware.Auth(s, cfg))

		// Project list (user's projects)
		r.Get("/projects", h.ListProjects)
		r.Post("/projects", h.CreateProject)

		// Project-specific routes
		r.Route("/projects/{projectId}", func(r chi.Router) {
			// Project membership middleware
			r.Use(middleware.ProjectMember(s))

			// SSE events endpoint (must be before other routes to avoid timeout middleware)
			r.Get("/events", h.Events)

			r.Get("/", h.GetProject)
			r.Put("/", h.UpdateProject)
			r.Delete("/", h.DeleteProject)

			// Members
			r.Get("/members", h.ListProjectMembers)
			r.Delete("/members/{userId}", h.RemoveProjectMember)

			// Invitations
			r.Post("/invitations", h.CreateInvitation)
			r.Post("/invitations/{token}/accept", h.AcceptInvitation)

			// Workspaces
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

			// Sessions (direct access)
			r.Route("/sessions", func(r chi.Router) {
				r.Get("/{sessionId}", h.GetSession)
				r.Put("/{sessionId}", h.UpdateSession)
				r.Delete("/{sessionId}", h.DeleteSession)
				r.Get("/{sessionId}/files", h.GetSessionFiles)
				r.Get("/{sessionId}/messages", h.ListMessages)
			})

			// Agents
			r.Route("/agents", func(r chi.Router) {
				r.Get("/", h.ListAgents)
				r.Post("/", h.CreateAgent)
				r.Get("/types", h.GetAgentTypes)
				r.Get("/auth-providers", h.GetAuthProviders)
				r.Post("/default", h.SetDefaultAgent)
				r.Get("/{agentId}", h.GetAgent)
				r.Put("/{agentId}", h.UpdateAgent)
				r.Delete("/{agentId}", h.DeleteAgent)
			})

			// Files
			r.Get("/files/{fileId}", h.GetFile)

			// Suggestions
			r.Get("/suggestions", h.GetSuggestions)

			// Credentials
			r.Route("/credentials", func(r chi.Router) {
				r.Get("/", h.ListCredentials)
				r.Post("/", h.CreateCredential)
				r.Get("/{provider}", h.GetCredential)
				r.Delete("/{provider}", h.DeleteCredential)

				// Anthropic OAuth
				r.Post("/anthropic/authorize", h.AnthropicAuthorize)
				r.Post("/anthropic/exchange", h.AnthropicExchange)

				// GitHub Copilot OAuth
				r.Post("/github-copilot/device-code", h.GitHubCopilotDeviceCode)
				r.Post("/github-copilot/poll", h.GitHubCopilotPoll)

				// Codex OAuth
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

	// Create server
	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.Port),
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in a goroutine
	go func() {
		log.Printf("Server starting on port %d", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Stop dispatcher first (finish in-flight jobs)
	if disp != nil {
		disp.Stop()
	}

	// Stop event poller
	eventPoller.Stop()

	// Close handler resources (stops Codex callback server, etc.)
	h.Close()

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server stopped")
}
