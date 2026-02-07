package handler

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"

	"github.com/obot-platform/discobot/server/internal/sandbox"
)

// DebugDockerServer runs a standalone HTTP server that proxies Docker API requests
// to the Docker daemon inside a VZ VM. This allows using standard Docker CLI:
//
//	DOCKER_HOST=tcp://localhost:2375 docker ps
type DebugDockerServer struct {
	server    *http.Server
	projectID string
}

// NewDebugDockerServer creates a new debug Docker proxy server for the given project.
func NewDebugDockerServer(sandboxManager *sandbox.Manager, projectID string, port int) (*DebugDockerServer, error) {
	// Find a provider that supports Docker proxying
	var proxyProvider sandbox.DockerProxyProvider
	for _, name := range sandboxManager.ListProviders() {
		provider, err := sandboxManager.GetProvider(name)
		if err != nil {
			continue
		}
		if dp, ok := provider.(sandbox.DockerProxyProvider); ok {
			proxyProvider = dp
			break
		}
	}

	if proxyProvider == nil {
		return nil, fmt.Errorf("no provider supports Docker proxying")
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = "http"
			req.URL.Host = "localhost"
			req.Host = "localhost"
		},
		Transport: &debugDockerTransport{
			provider:  proxyProvider,
			projectID: projectID,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("Debug Docker proxy error: %v", err)
			http.Error(w, err.Error(), http.StatusBadGateway)
		},
	}

	return &DebugDockerServer{
		projectID: projectID,
		server: &http.Server{
			Addr:    fmt.Sprintf(":%d", port),
			Handler: proxy,
		},
	}, nil
}

// Start starts the debug Docker proxy server in the background.
func (s *DebugDockerServer) Start() {
	go func() {
		log.Printf("Debug Docker proxy listening on %s (project: %s)", s.server.Addr, s.projectID)
		log.Printf("  Usage: DOCKER_HOST=tcp://localhost%s docker ps", s.server.Addr)
		if err := s.server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("Debug Docker proxy error: %v", err)
		}
	}()
}

// Stop stops the debug Docker proxy server.
func (s *DebugDockerServer) Stop() {
	_ = s.server.Close()
}

// debugDockerTransport lazily resolves the Docker transport for the project VM.
// This allows the proxy to start before the VM is ready (e.g., during image download).
type debugDockerTransport struct {
	provider  sandbox.DockerProxyProvider
	projectID string
}

func (t *debugDockerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	transport, err := t.provider.DockerTransport(t.projectID)
	if err != nil {
		return nil, fmt.Errorf("VM not available: %w", err)
	}
	return transport.RoundTrip(req)
}
