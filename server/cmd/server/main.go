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

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/database"
	"github.com/anthropics/octobot/server/internal/handler"
	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/store"
	"github.com/anthropics/octobot/server/static"
	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/joho/godotenv"
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
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// API UI - serve the embedded static HTML file
	r.Get("/api/ui", func(w http.ResponseWriter, r *http.Request) {
		content, err := static.Files.ReadFile("api-ui.html")
		if err != nil {
			http.Error(w, "API UI not found", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(content)
	})

	// Initialize handlers
	h := handler.New(s, cfg)

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

				// Sessions within workspace
				r.Get("/{workspaceId}/sessions", h.ListSessionsByWorkspace)
				r.Post("/{workspaceId}/sessions", h.CreateSession)
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

			// Terminal
			r.Get("/terminal/ws", h.TerminalWebSocket)
			r.Get("/terminal/history", h.GetTerminalHistory)
			r.Get("/terminal/status", h.GetTerminalStatus)
		})
	})

	// AI Chat endpoint
	r.Post("/api/chat", h.Chat)

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

	// Graceful shutdown with timeout
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server stopped")
}
