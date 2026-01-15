package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/anthropics/octobot/server/internal/sandbox"
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

// SandboxChatRequest is the request sent to the sandbox's chat endpoint.
// Messages is passed through as raw JSON without parsing.
type SandboxChatRequest struct {
	Messages json.RawMessage `json:"messages"`
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

// UIMessage represents a message in UIMessage format from the sandbox.
type UIMessage struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Parts     json.RawMessage `json:"parts"`
	CreatedAt string          `json:"createdAt,omitempty"`
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

// SendMessagesOptions contains optional parameters for SendMessages.
type SendMessagesOptions struct {
	// Credentials to pass to the sandbox via header (envVar -> value mappings)
	Credentials []CredentialEnvVar
}

// SendMessages sends messages to the sandbox and returns a channel of raw SSE lines.
// The sandbox is expected to respond with SSE events in AI SDK UIMessage Stream format.
// Messages and responses are passed through without parsing.
func (c *SandboxChatClient) SendMessages(ctx context.Context, sessionID string, messages json.RawMessage, opts *SendMessagesOptions) (<-chan SSELine, error) {
	baseURL, err := c.getSandboxURL(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Build the request - pass messages through as-is
	reqBody := SandboxChatRequest{Messages: messages}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create the HTTP request
	req, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/chat", bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")

	// Add credentials header if provided
	if opts != nil && len(opts.Credentials) > 0 {
		credJSON, err := json.Marshal(opts.Credentials)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal credentials: %w", err)
		}
		req.Header.Set("X-Octobot-Credentials", string(credJSON))
	}

	// Send the request
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	// Create channel for raw SSE lines
	lineCh := make(chan SSELine, 100)

	// Start goroutine to read SSE lines and pass through
	go func() {
		defer close(lineCh)
		defer resp.Body.Close()

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
func (c *SandboxChatClient) GetMessages(ctx context.Context, sessionID string) ([]UIMessage, error) {
	baseURL, err := c.getSandboxURL(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, "GET", baseURL+"/chat", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("sandbox returned status %d: %s", resp.StatusCode, string(body))
	}

	var messages []UIMessage
	if err := json.NewDecoder(resp.Body).Decode(&messages); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return messages, nil
}
