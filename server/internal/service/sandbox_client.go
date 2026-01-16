package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"syscall"
	"time"

	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/sandbox/sandboxapi"
)

// Retry configuration for sandbox requests.
// Uses aggressive initial backoff to catch container startup quickly.
const (
	retryInitialDelay = 50 * time.Millisecond // Start very aggressive
	retryMaxDelay     = 2 * time.Second       // Cap delay
	retryMaxAttempts  = 15                    // Total attempts
	retryMultiplier   = 2.0                   // Double each time
)

// SandboxChatClient handles communication with the agent running in a sandbox.
type SandboxChatClient struct {
	provider sandbox.Provider
	client   *http.Client
}

// NewSandboxChatClient creates a new sandbox chat client.
func NewSandboxChatClient(provider sandbox.Provider) *SandboxChatClient {
	return &SandboxChatClient{
		provider: provider,
		client:   &http.Client{},
	}
}

// isRetryableError checks if an error is a transient protocol error that should be retried.
func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	// Connection refused - container not ready yet
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	// Connection reset - container restarting
	if errors.Is(err, syscall.ECONNRESET) {
		return true
	}
	// Check for common network error patterns in the error string
	errStr := err.Error()
	return strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "no such host") ||
		strings.Contains(errStr, "i/o timeout")
}

// isRetryableStatus checks if an HTTP status code should trigger a retry.
func isRetryableStatus(statusCode int) bool {
	return statusCode >= 500 && statusCode < 600
}

// retryWithBackoff executes fn with exponential backoff on retryable errors.
// Returns the result of fn or the last error after max attempts.
func retryWithBackoff[T any](ctx context.Context, fn func() (T, int, error)) (T, error) {
	var zero T
	delay := retryInitialDelay

	for attempt := 1; attempt <= retryMaxAttempts; attempt++ {
		result, statusCode, err := fn()

		// Success
		if err == nil && !isRetryableStatus(statusCode) {
			return result, nil
		}

		// Check if we should retry
		shouldRetry := isRetryableError(err) || isRetryableStatus(statusCode)
		if !shouldRetry || attempt == retryMaxAttempts {
			if err != nil {
				return zero, err
			}
			return result, nil
		}

		// Wait before retry, respecting context cancellation
		select {
		case <-ctx.Done():
			return zero, ctx.Err()
		case <-time.After(delay):
		}

		// Increase delay for next iteration
		delay = min(time.Duration(float64(delay)*retryMultiplier), retryMaxDelay)
	}

	return zero, fmt.Errorf("max retry attempts exceeded")
}

// SSELine represents a raw SSE data line from the sandbox.
// The content is passed through without parsing - the sandbox
// is expected to send data in AI SDK UIMessage Stream format.
type SSELine struct {
	// Data is the raw JSON payload (without "data: " prefix)
	Data string
	// Done indicates this is the [DONE] signal
	Done bool
}

// getSandboxURL returns the base URL for the sandbox's HTTP endpoint.
func (c *SandboxChatClient) getSandboxURL(ctx context.Context, sessionID string) (string, error) {
	sb, err := c.provider.Get(ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("failed to get sandbox: %w", err)
	}

	if sb.Status != sandbox.StatusRunning {
		return "", fmt.Errorf("sandbox is not running: %s", sb.Status)
	}

	// Find the chat port (3002)
	var chatPort *sandbox.AssignedPort
	for i := range sb.Ports {
		if sb.Ports[i].ContainerPort == 3002 {
			chatPort = &sb.Ports[i]
			break
		}
	}
	if chatPort == nil {
		return "", fmt.Errorf("sandbox does not expose port 3002")
	}

	hostIP := chatPort.HostIP
	if hostIP == "" || hostIP == "0.0.0.0" {
		hostIP = "127.0.0.1"
	}

	return fmt.Sprintf("http://%s:%d", hostIP, chatPort.HostPort), nil
}

// RequestOptions contains optional parameters for sandbox requests.
type RequestOptions struct {
	// Credentials to pass to the sandbox via header (envVar -> value mappings)
	Credentials []CredentialEnvVar
}

// applyRequestAuth sets Authorization and credentials headers on a request.
func (c *SandboxChatClient) applyRequestAuth(ctx context.Context, req *http.Request, sessionID string, opts *RequestOptions) error {
	// Add Authorization header with Bearer token
	secret, err := c.provider.GetSecret(ctx, sessionID)
	if err == nil && secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}

	// Add credentials header if provided
	if opts != nil && len(opts.Credentials) > 0 {
		credJSON, err := json.Marshal(opts.Credentials)
		if err != nil {
			return fmt.Errorf("failed to marshal credentials: %w", err)
		}
		req.Header.Set("X-Octobot-Credentials", string(credJSON))
	}

	return nil
}

// SendMessages sends messages to the sandbox and returns a channel of raw SSE lines.
// The sandbox is expected to respond with SSE events in AI SDK UIMessage Stream format.
// Messages and responses are passed through without parsing.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) SendMessages(ctx context.Context, sessionID string, messages json.RawMessage, opts *RequestOptions) (<-chan SSELine, error) {
	// Build the request body once - pass messages through as-is
	reqBody := sandboxapi.ChatRequest{Messages: messages}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Use retry logic to handle container startup delays
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		baseURL, err := c.getSandboxURL(ctx, sessionID)
		if err != nil {
			// Treat sandbox not running as retryable
			if strings.Contains(err.Error(), "sandbox is not running") {
				return nil, 0, fmt.Errorf("connection refused: %w", err)
			}
			return nil, 0, err
		}

		// Create the HTTP request (fresh each attempt since body reader is consumed)
		req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/chat", bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")

		if err := c.applyRequestAuth(ctx, req, sessionID, opts); err != nil {
			return nil, 0, err
		}

		// Send the request
		resp, err := c.client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		// Return response with status code for retry logic
		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	// Create channel for raw SSE lines
	lineCh := make(chan SSELine, 100)

	// Start goroutine to read SSE lines and pass through
	go func() {
		defer close(lineCh)
		defer func() { _ = resp.Body.Close() }()

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()

			// Skip empty lines and comments
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}

			// Pass through SSE data lines
			if strings.HasPrefix(line, "data: ") {
				data := line[6:]

				// Check for [DONE] signal
				if data == "[DONE]" {
					select {
					case lineCh <- SSELine{Done: true}:
					case <-ctx.Done():
					}
					return
				}

				// Pass through raw data without parsing
				select {
				case lineCh <- SSELine{Data: data}:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return lineCh, nil
}

// GetMessages retrieves message history from the sandbox.
// The sandbox is expected to respond with an array of UIMessages.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetMessages(ctx context.Context, sessionID string, opts *RequestOptions) ([]sandboxapi.UIMessage, error) {
	// Use retry logic to handle container startup delays
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		baseURL, err := c.getSandboxURL(ctx, sessionID)
		if err != nil {
			// Treat sandbox not running as retryable
			if strings.Contains(err.Error(), "sandbox is not running") {
				return nil, 0, fmt.Errorf("connection refused: %w", err)
			}
			return nil, 0, err
		}

		req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/chat", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, opts); err != nil {
			return nil, 0, err
		}

		resp, err := c.client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var response sandboxapi.GetMessagesResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return response.Messages, nil
}
