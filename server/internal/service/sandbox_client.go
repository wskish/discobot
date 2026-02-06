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

	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/sandboxapi"
	"github.com/obot-platform/discobot/server/internal/store"
)

// Retry configuration for sandbox requests.
// Uses aggressive initial backoff to catch container startup quickly.
const (
	retryInitialDelay = 50 * time.Millisecond // Start very aggressive
	retryMaxDelay     = 2 * time.Second       // Cap delay
	retryMaxAttempts  = 15                    // Total attempts
	retryMultiplier   = 2.0                   // Double each time
)

// CredentialFetcher is a function that retrieves credentials for a session.
// It looks up the session to get the project ID, then fetches decrypted credentials.
type CredentialFetcher func(ctx context.Context, sessionID string) ([]CredentialEnvVar, error)

// makeCredentialFetcher creates a CredentialFetcher that looks up credentials for a session.
// Returns nil if credSvc is nil (credentials will not be fetched).
func makeCredentialFetcher(s *store.Store, credSvc *CredentialService) CredentialFetcher {
	if credSvc == nil {
		return nil
	}
	return func(ctx context.Context, sessionID string) ([]CredentialEnvVar, error) {
		sess, err := s.GetSessionByID(ctx, sessionID)
		if err != nil {
			return nil, fmt.Errorf("failed to get session: %w", err)
		}
		return credSvc.GetAllDecrypted(ctx, sess.ProjectID)
	}
}

// SandboxChatClient handles communication with the agent running in a sandbox.
type SandboxChatClient struct {
	provider          sandbox.Provider
	credentialFetcher CredentialFetcher
}

// NewSandboxChatClient creates a new sandbox chat client.
// The fetcher parameter is optional - if nil, credentials will not be automatically fetched.
func NewSandboxChatClient(provider sandbox.Provider, fetcher CredentialFetcher) *SandboxChatClient {
	return &SandboxChatClient{
		provider:          provider,
		credentialFetcher: fetcher,
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
	// EOF - connection closed before response (container still starting)
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	// Check for common network error patterns in the error string
	errStr := err.Error()
	return strings.Contains(errStr, "connection refused") ||
		strings.Contains(errStr, "connection reset") ||
		strings.Contains(errStr, "no such host") ||
		strings.Contains(errStr, "i/o timeout") ||
		strings.Contains(errStr, "EOF")
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

// getHTTPClient returns an HTTP client configured for the sandbox.
// This uses the provider's HTTPClient which handles transport-level details
// (TCP for Docker, vsock for vz, mock transport for testing).
func (c *SandboxChatClient) getHTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	return c.provider.HTTPClient(ctx, sessionID)
}

// RequestOptions contains optional parameters for sandbox requests.
type RequestOptions struct {
	// SkipCredentials opts out of automatic credential fetching.
	// By default, credentials are fetched and sent with requests.
	SkipCredentials bool

	// GitUserName is the git user.name to use for commits (optional).
	GitUserName string

	// GitUserEmail is the git user.email to use for commits (optional).
	GitUserEmail string
}

// applyRequestAuth sets Authorization and credentials headers on a request.
// Credentials are automatically fetched unless SkipCredentials is set.
func (c *SandboxChatClient) applyRequestAuth(ctx context.Context, req *http.Request, sessionID string, opts *RequestOptions) error {
	// Add Authorization header with Bearer token
	secret, err := c.provider.GetSecret(ctx, sessionID)
	if err == nil && secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}

	// Auto-fetch credentials if fetcher is set and not skipped
	skipCreds := opts != nil && opts.SkipCredentials
	if c.credentialFetcher != nil && !skipCreds {
		creds, err := c.credentialFetcher(ctx, sessionID)
		if err != nil {
			// Log warning but don't fail - credentials are optional
			fmt.Printf("Warning: failed to fetch credentials for session %s: %v\n", sessionID, err)
		} else if len(creds) > 0 {
			credJSON, err := json.Marshal(creds)
			if err != nil {
				return fmt.Errorf("failed to marshal credentials: %w", err)
			}
			req.Header.Set("X-Discobot-Credentials", string(credJSON))
		}
	}

	// Add git user config headers if provided
	if opts != nil {
		if opts.GitUserName != "" {
			req.Header.Set("X-Discobot-Git-User-Name", opts.GitUserName)
		}
		if opts.GitUserEmail != "" {
			req.Header.Set("X-Discobot-Git-User-Email", opts.GitUserEmail)
		}
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

	// Use retry logic to handle transient connection errors during container startup
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			// Don't retry on sandbox not running - let caller handle reconciliation
			return nil, 0, err
		}

		// Create the HTTP request (fresh each attempt since body reader is consumed)
		// URL host is ignored - the client's transport handles routing to the sandbox
		req, err := http.NewRequestWithContext(ctx, "POST", "http://sandbox/chat", bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "text/event-stream")

		if err := c.applyRequestAuth(ctx, req, sessionID, opts); err != nil {
			return nil, 0, err
		}

		// Send the request
		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		// Return response with status code for retry logic
		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	if resp.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}
	_ = resp.Body.Close()

	// POST returns 202 Accepted - now GET the SSE stream
	return c.GetStream(ctx, sessionID, opts)
}

// GetStream connects to the sandbox's SSE stream for an in-progress completion.
// Returns a channel of raw SSE lines. If no completion is in progress, the sandbox
// returns 204 No Content and this method returns an empty closed channel.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetStream(ctx context.Context, sessionID string, opts *RequestOptions) (<-chan SSELine, error) {
	// Use retry logic to handle transient connection errors during container startup
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			// Don't retry on sandbox not running - let caller handle reconciliation
			return nil, 0, err
		}

		// URL host is ignored - the client's transport handles routing to the sandbox
		req, err := http.NewRequestWithContext(ctx, "GET", "http://sandbox/chat", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Accept", "text/event-stream")

		if err := c.applyRequestAuth(ctx, req, sessionID, opts); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	// 204 No Content means no completion in progress
	if resp.StatusCode == http.StatusNoContent {
		_ = resp.Body.Close()
		ch := make(chan SSELine)
		close(ch)
		return ch, nil
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
	// Use retry logic to handle transient connection errors during container startup
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			// Don't retry on sandbox not running - let caller handle reconciliation
			return nil, 0, err
		}

		// URL host is ignored - the client's transport handles routing to the sandbox
		req, err := http.NewRequestWithContext(ctx, "GET", "http://sandbox/chat", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, opts); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
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

// GetChatStatus retrieves the completion status from the sandbox.
// Returns whether a completion is currently running.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetChatStatus(ctx context.Context, sessionID string) (*sandboxapi.ChatStatusResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		url := "http://sandbox/chat/status"
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get chat status: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var status sandboxapi.ChatStatusResponse
	if err := json.Unmarshal(body, &status); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &status, nil
}

// CancelCompletion cancels an in-progress completion in the sandbox.
// Returns ErrNoActiveCompletion if no completion is active (409 status).
// Retries with exponential backoff on connection errors.
func (c *SandboxChatClient) CancelCompletion(ctx context.Context, sessionID string) (*CancelCompletionResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		req, err := http.NewRequestWithContext(ctx, "POST", "http://sandbox/chat/cancel", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to cancel completion: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode == http.StatusConflict {
		return nil, ErrNoActiveCompletion
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result CancelCompletionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// ============================================================================
// File System Methods
// ============================================================================

// ListFiles lists directory contents in the sandbox.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) ListFiles(ctx context.Context, sessionID string, path string, includeHidden bool) (*sandboxapi.ListFilesResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		// Build URL with query parameters
		url := "http://sandbox/files?path=" + path
		if includeHidden {
			url += "&hidden=true"
		}

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list files: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.ListFilesResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// ReadFile reads file content from the sandbox.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) ReadFile(ctx context.Context, sessionID string, path string) (*sandboxapi.ReadFileResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		url := "http://sandbox/files/read?path=" + path

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.ReadFileResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// WriteFile writes file content to the sandbox.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) WriteFile(ctx context.Context, sessionID string, req *sandboxapi.WriteFileRequest) (*sandboxapi.WriteFileResponse, error) {
	bodyBytes, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		httpReq, err := http.NewRequestWithContext(ctx, "POST", "http://sandbox/files/write", bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}
		httpReq.Header.Set("Content-Type", "application/json")

		if err := c.applyRequestAuth(ctx, httpReq, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(httpReq)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to write file: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.WriteFileResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// GetUserInfo retrieves the default user info from the sandbox.
// This is used to determine which user to run terminal sessions as.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetUserInfo(ctx context.Context, sessionID string) (*sandboxapi.UserResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		req, err := http.NewRequestWithContext(ctx, "GET", "http://sandbox/user", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get user info: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.UserResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// GetDiff retrieves diff information from the sandbox.
// If path is non-empty, returns a single file diff.
// If format is "files", returns just file paths.
// Otherwise returns full diff with patches.
// The agent-api calculates the merge-base automatically.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetDiff(ctx context.Context, sessionID string, path string, format string) (any, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		// Build URL with query parameters
		url := "http://sandbox/diff"
		params := []string{}
		if path != "" {
			params = append(params, "path="+path)
		}
		if format != "" {
			params = append(params, "format="+format)
		}
		if len(params) > 0 {
			url += "?" + strings.Join(params, "&")
		}

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get diff: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	// Decode based on request parameters
	if path != "" {
		var result sandboxapi.SingleFileDiffResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("failed to decode response: %w", err)
		}
		return &result, nil
	}

	if format == "files" {
		var result sandboxapi.DiffFilesResponse
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return nil, fmt.Errorf("failed to decode response: %w", err)
		}
		return &result, nil
	}

	var result sandboxapi.DiffResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}
	return &result, nil
}

// GetCommits retrieves git format-patch output from the sandbox for commits since a parent.
// Returns the patches string and commit count on success, or an error on failure.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetCommits(ctx context.Context, sessionID string, parentCommit string) (*sandboxapi.CommitsResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		// Build URL with query parameter
		url := "http://sandbox/commits?parent=" + parentCommit

		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get commits: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Check for error responses (400, 404, 409)
	if resp.StatusCode != http.StatusOK {
		var errResp sandboxapi.CommitsErrorResponse
		if err := json.NewDecoder(resp.Body).Decode(&errResp); err != nil {
			body, _ := io.ReadAll(resp.Body)
			return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
		}
		return nil, fmt.Errorf("commits error (%s): %s", errResp.Error, errResp.Message)
	}

	var result sandboxapi.CommitsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// ============================================================================
// Service Methods
// ============================================================================

// ListServices retrieves all services from the sandbox.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) ListServices(ctx context.Context, sessionID string) (*sandboxapi.ListServicesResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		req, err := http.NewRequestWithContext(ctx, "GET", "http://sandbox/services", nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.ListServicesResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// StartService starts a service in the sandbox.
// Returns immediately with status "starting" (202 Accepted).
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) StartService(ctx context.Context, sessionID string, serviceID string) (*sandboxapi.StartServiceResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		url := "http://sandbox/services/" + serviceID + "/start"
		req, err := http.NewRequestWithContext(ctx, "POST", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to start service: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	// 202 Accepted is success, also handle 200 OK
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.StartServiceResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// StopService stops a service in the sandbox.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) StopService(ctx context.Context, sessionID string, serviceID string) (*sandboxapi.StopServiceResponse, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		url := "http://sandbox/services/" + serviceID + "/stop"
		req, err := http.NewRequestWithContext(ctx, "POST", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to stop service: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var result sandboxapi.StopServiceResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// GetServiceOutput connects to the sandbox's SSE stream for service output.
// Returns a channel of raw SSE lines. The channel is closed when the service
// stops or the context is cancelled.
// Retries with exponential backoff on connection errors and 5xx responses.
func (c *SandboxChatClient) GetServiceOutput(ctx context.Context, sessionID string, serviceID string) (<-chan SSELine, error) {
	resp, err := retryWithBackoff(ctx, func() (*http.Response, int, error) {
		client, err := c.getHTTPClient(ctx, sessionID)
		if err != nil {
			return nil, 0, err
		}

		url := "http://sandbox/services/" + serviceID + "/output"
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to create request: %w", err)
		}
		req.Header.Set("Accept", "text/event-stream")

		if err := c.applyRequestAuth(ctx, req, sessionID, nil); err != nil {
			return nil, 0, err
		}

		resp, err := client.Do(req)
		if err != nil {
			return nil, 0, err
		}

		return resp, resp.StatusCode, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get service output: %w", err)
	}

	// 404 means service not found
	if resp.StatusCode == http.StatusNotFound {
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		return nil, fmt.Errorf("service not found: %s", string(body))
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
