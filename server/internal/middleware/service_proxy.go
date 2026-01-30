package middleware

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"github.com/obot-platform/discobot/server/internal/sandbox"
)

// serviceSubdomainPattern matches {session-id}-svc-{service-id}.* subdomains.
// Session IDs are 10-26 alphanumeric chars (case-insensitive in URLs).
// Service IDs are normalized lowercase (a-z0-9_- only).
var serviceSubdomainPattern = regexp.MustCompile(`^([0-9A-Za-z]{10,26})-svc-([a-z0-9_-]+)\.`)

// findSessionID finds the actual session ID with correct casing.
// DNS/URLs are case-insensitive, so we need to do a case-insensitive lookup.
func findSessionID(ctx context.Context, provider sandbox.Provider, urlSessionID string) (string, error) {
	// First try exact match (fast path)
	sb, err := provider.Get(ctx, urlSessionID)
	if err == nil && sb != nil {
		return sb.SessionID, nil
	}

	// Fall back to case-insensitive search via List
	sandboxes, err := provider.List(ctx)
	if err != nil {
		return "", fmt.Errorf("failed to list sandboxes: %w", err)
	}

	lowerURLSessionID := strings.ToLower(urlSessionID)
	for _, sb := range sandboxes {
		if strings.ToLower(sb.SessionID) == lowerURLSessionID {
			return sb.SessionID, nil
		}
	}

	return "", fmt.Errorf("session not found: %s", urlSessionID)
}

// ServiceProxy creates middleware that intercepts requests to service subdomains
// and proxies them to the agent-api's HTTP proxy endpoint using httputil.ReverseProxy.
//
// Subdomain format: {session-id}-svc-{service-id}.{base-domain}
// Example: 01HXYZ123456789ABCDEFGHIJ-svc-myservice.localhost:3000
//
// The proxy does NOT pass credentials to the agent-api, as service HTTP
// endpoints are considered public within the sandbox.
//
// This properly handles:
// - HTTP/1.1 and HTTP/2
// - WebSocket upgrades
// - Server-Sent Events (SSE)
// - Chunked transfer encoding
// - Request/response streaming
func ServiceProxy(provider sandbox.Provider) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.Host

			// Try to match service subdomain pattern
			matches := serviceSubdomainPattern.FindStringSubmatch(host)
			if matches == nil {
				// Not a service subdomain, continue to next handler
				next.ServeHTTP(w, r)
				return
			}

			urlSessionID := matches[1]
			serviceID := matches[2]
			ctx := r.Context()

			// Find the actual session ID with correct casing
			sessionID, err := findSessionID(ctx, provider, urlSessionID)
			if err != nil {
				writeJSONError(w, http.StatusBadGateway, "Failed to find session", map[string]string{
					"sessionId": urlSessionID,
					"serviceId": serviceID,
					"message":   err.Error(),
				})
				return
			}

			// Get HTTP client for the sandbox (handles transport-level routing)
			client, err := provider.HTTPClient(ctx, sessionID)
			if err != nil {
				writeJSONError(w, http.StatusBadGateway, "Failed to connect to sandbox", map[string]string{
					"sessionId": sessionID,
					"serviceId": serviceID,
					"message":   err.Error(),
				})
				return
			}

			// Target URL for the agent-api
			// The agent-api expects: /services/:id/http/*
			target, _ := url.Parse("http://sandbox")

			// Create reverse proxy
			proxy := &httputil.ReverseProxy{
				Director: func(req *http.Request) {
					req.URL.Scheme = target.Scheme
					req.URL.Host = target.Host
					req.URL.Path = "/services/" + serviceID + "/http" + r.URL.Path
					req.URL.RawQuery = r.URL.RawQuery

					// Set the Host header to the target
					req.Host = target.Host

					// Set x-forwarded-* headers
					req.Header.Set("X-Forwarded-Path", r.URL.Path)
					req.Header.Set("X-Forwarded-Host", r.Host)
					req.Header.Set("X-Forwarded-Proto", getScheme(r))

					// Preserve or append X-Forwarded-For
					clientIP := r.RemoteAddr
					if idx := strings.LastIndex(clientIP, ":"); idx != -1 {
						clientIP = clientIP[:idx]
					}
					if prior := r.Header.Get("X-Forwarded-For"); prior != "" {
						req.Header.Set("X-Forwarded-For", prior+", "+clientIP)
					} else {
						req.Header.Set("X-Forwarded-For", clientIP)
					}
				},
				Transport: client.Transport,
				ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
					log.Printf("[ServiceProxy] Error proxying request to %s: %v", r.URL.String(), err)
					writeJSONError(w, http.StatusBadGateway, "Service unavailable", map[string]string{
						"sessionId": sessionID,
						"serviceId": serviceID,
						"message":   err.Error(),
					})
				},
				// Streaming support - don't buffer responses
				FlushInterval: -1, // Flush immediately
			}

			proxy.ServeHTTP(w, r)
		})
	}
}

// writeJSONError writes a JSON error response.
func writeJSONError(w http.ResponseWriter, status int, errorType string, fields map[string]string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	// Build JSON manually to avoid import cycles
	parts := []string{fmt.Sprintf(`"error":%q`, errorType)}
	for k, v := range fields {
		parts = append(parts, fmt.Sprintf(`%q:%q`, k, v))
	}
	fmt.Fprintf(w, "{%s}", strings.Join(parts, ","))
}

// getScheme returns the request scheme (http or https).
func getScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
		return proto
	}
	return "http"
}
