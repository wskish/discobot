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

	"github.com/anthropics/octobot/server/internal/container"
)

// ContainerChatClient handles communication with the agent running in a container.
type ContainerChatClient struct {
	runtime container.Runtime
	client  *http.Client
}

// NewContainerChatClient creates a new container chat client.
func NewContainerChatClient(runtime container.Runtime) *ContainerChatClient {
	return &ContainerChatClient{
		runtime: runtime,
		client:  &http.Client{},
	}
}

// ChatRequest is the request sent to the container's chat endpoint.
type ChatRequest struct {
	Message string `json:"message"`
}

// UIMessageEvent represents a streaming event from the container.
// This matches the AI SDK UI Message Stream Protocol.
type UIMessageEvent struct {
	Type string `json:"type"`

	// For message events
	ID        string `json:"id,omitempty"`
	MessageID string `json:"messageId,omitempty"`

	// For delta events
	Delta string `json:"delta,omitempty"`

	// For tool events
	ToolCallID string `json:"toolCallId,omitempty"`
	ToolName   string `json:"toolName,omitempty"`
	Input      any    `json:"input,omitempty"`
	Output     any    `json:"output,omitempty"`

	// For error events
	ErrorText string `json:"errorText,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// UIMessage represents a message in UIMessage format from the container.
type UIMessage struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"`
	Parts     json.RawMessage `json:"parts"`
	CreatedAt string          `json:"createdAt,omitempty"`
}

// getContainerURL returns the base URL for the container's HTTP endpoint.
func (c *ContainerChatClient) getContainerURL(ctx context.Context, sessionID string) (string, error) {
	cont, err := c.runtime.Get(ctx, sessionID)
	if err != nil {
		return "", fmt.Errorf("failed to get container: %w", err)
	}

	if cont.Status != container.StatusRunning {
		return "", fmt.Errorf("container is not running: %s", cont.Status)
	}

	// Find the chat port (8080)
	var chatPort *container.AssignedPort
	for i := range cont.Ports {
		if cont.Ports[i].ContainerPort == 8080 {
			chatPort = &cont.Ports[i]
			break
		}
	}
	if chatPort == nil {
		return "", fmt.Errorf("container does not expose port 8080")
	}

	hostIP := chatPort.HostIP
	if hostIP == "" || hostIP == "0.0.0.0" {
		hostIP = "127.0.0.1"
	}

	return fmt.Sprintf("http://%s:%d", hostIP, chatPort.HostPort), nil
}

// SendMessage sends a user message to the container and returns a channel of events.
// The container is expected to respond with SSE events in UIMessage format.
func (c *ContainerChatClient) SendMessage(ctx context.Context, sessionID string, message string) (<-chan UIMessageEvent, error) {
	baseURL, err := c.getContainerURL(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	// Build the request
	reqBody := ChatRequest{Message: message}
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

	// Send the request
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("container returned status %d: %s", resp.StatusCode, string(body))
	}

	// Create channel for events
	eventCh := make(chan UIMessageEvent, 100)

	// Start goroutine to read SSE events
	go func() {
		defer close(eventCh)
		defer resp.Body.Close()

		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()

			// Skip empty lines and comments
			if line == "" || strings.HasPrefix(line, ":") {
				continue
			}

			// Parse SSE data lines
			if strings.HasPrefix(line, "data: ") {
				data := line[6:]

				// Check for [DONE] signal
				if data == "[DONE]" {
					return
				}

				var event UIMessageEvent
				if err := json.Unmarshal([]byte(data), &event); err != nil {
					// Log but continue
					continue
				}

				select {
				case eventCh <- event:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return eventCh, nil
}

// GetMessages retrieves message history from the container.
// The container is expected to respond with an array of UIMessages.
func (c *ContainerChatClient) GetMessages(ctx context.Context, sessionID string) ([]UIMessage, error) {
	baseURL, err := c.getContainerURL(ctx, sessionID)
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
		return nil, fmt.Errorf("container returned status %d: %s", resp.StatusCode, string(body))
	}

	var messages []UIMessage
	if err := json.NewDecoder(resp.Body).Decode(&messages); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return messages, nil
}
