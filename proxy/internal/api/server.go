// Package proxyapi provides the REST API for runtime configuration.
package proxyapi

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/obot-platform/octobot/proxy/internal/config"
	"github.com/obot-platform/octobot/proxy/internal/logger"
	"github.com/obot-platform/octobot/proxy/internal/proxy"
)

// Server is the API server for runtime configuration.
type Server struct {
	router chi.Router
	proxy  *proxy.Server
	logger *logger.Logger
}

// New creates a new API server.
func New(proxyServer *proxy.Server, log *logger.Logger) *Server {
	s := &Server{
		proxy:  proxyServer,
		logger: log,
	}
	s.setupRoutes()
	return s
}

func (s *Server) setupRoutes() {
	r := chi.NewRouter()

	// Middleware
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(s.requestLogger)

	// Health check
	r.Get("/health", s.handleHealth)

	// Configuration endpoint
	r.Post("/api/config", s.handleSetConfig)
	r.Patch("/api/config", s.handlePatchConfig)

	s.router = r
}

func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.logger.Debug("api request",
			"method", r.Method,
			"path", r.URL.Path,
		)
		next.ServeHTTP(w, r)
	})
}

// ListenAndServe starts the API server.
func (s *Server) ListenAndServe(addr string) error {
	s.logger.Info("api server started", "addr", addr)
	server := &http.Server{
		Addr:              addr,
		Handler:           s.router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	return server.ListenAndServe()
}

// handleHealth handles GET /health.
func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	s.jsonOK(w, map[string]string{
		"status":  "ok",
		"ca_cert": s.proxy.GetCACertPath(),
	})
}

// handleSetConfig handles POST /api/config (complete overwrite).
func (s *Server) handleSetConfig(w http.ResponseWriter, r *http.Request) {
	var cfg config.RuntimeConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		s.jsonError(w, "invalid JSON: "+err.Error())
		return
	}

	if err := s.validateConfig(&cfg); err != nil {
		s.jsonError(w, err.Error())
		return
	}

	s.proxy.ApplyRuntimeConfig(&cfg, false)
	s.logger.Info("config replaced via API")

	s.jsonOK(w, map[string]string{"status": "ok"})
}

// handlePatchConfig handles PATCH /api/config (merge).
func (s *Server) handlePatchConfig(w http.ResponseWriter, r *http.Request) {
	var cfg config.RuntimeConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		s.jsonError(w, "invalid JSON: "+err.Error())
		return
	}

	if err := s.validateConfig(&cfg); err != nil {
		s.jsonError(w, err.Error())
		return
	}

	s.proxy.ApplyRuntimeConfig(&cfg, true)
	s.logger.Info("config patched via API")

	s.jsonOK(w, map[string]string{"status": "ok"})
}

func (s *Server) validateConfig(cfg *config.RuntimeConfig) error {
	// Validate domain patterns in headers
	for domain := range cfg.Headers {
		if !config.IsValidDomainPattern(domain) {
			return fmt.Errorf("invalid domain pattern: %s", domain)
		}
	}

	// Validate domain patterns in allowlist
	if cfg.Allowlist != nil {
		for _, domain := range cfg.Allowlist.Domains {
			if !config.IsValidDomainPattern(domain) {
				return fmt.Errorf("invalid allowlist domain: %s", domain)
			}
		}
		// Validate IPs/CIDRs
		for _, ip := range cfg.Allowlist.IPs {
			if _, _, err := net.ParseCIDR(ip); err != nil {
				if net.ParseIP(ip) == nil {
					return fmt.Errorf("invalid IP/CIDR: %s", ip)
				}
			}
		}
	}

	return nil
}

func (s *Server) jsonOK(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

func (s *Server) jsonError(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
