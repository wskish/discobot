package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/sandboxapi"
)

// SessionInitializer breaks the circular dependency between SandboxService and SessionService.
// SessionService implements this interface via its existing Initialize method.
type SessionInitializer interface {
	Initialize(ctx context.Context, sessionID string) error
}

// SessionClient is a session-bound wrapper around SandboxChatClient.
// It removes the need to pass sessionID on every call and automatically
// reconciles the sandbox on unavailability errors.
type SessionClient struct {
	sessionID  string
	inner      *SandboxChatClient
	sandboxSvc *SandboxService
}

// withReconciliation wraps a sandbox operation with error handling that
// triggers reconciliation on sandbox unavailable errors, then retries once.
func withReconciliation[T any](ctx context.Context, c *SessionClient, operation func() (T, error)) (T, error) {
	result, err := operation()
	if err == nil {
		return result, nil
	}

	if errors.Is(err, sandbox.ErrNotFound) || errors.Is(err, sandbox.ErrNotRunning) || isSandboxUnavailableError(err) {
		log.Printf("Sandbox unavailable for session %s, reconciling: %v", c.sessionID, err)

		if reconcileErr := c.sandboxSvc.ReconcileSandbox(ctx, c.sessionID); reconcileErr != nil {
			var zero T
			return zero, fmt.Errorf("sandbox unavailable and failed to reconcile: %w", reconcileErr)
		}

		return operation()
	}

	var zero T
	return zero, err
}

// isSandboxUnavailableError checks if the error indicates the sandbox is unavailable
// and should be recreated.
func isSandboxUnavailableError(err error) bool {
	if err == nil {
		return false
	}
	errStr := err.Error()
	return strings.Contains(errStr, "sandbox not found") ||
		strings.Contains(errStr, "sandbox is not running") ||
		strings.Contains(errStr, "container not found") ||
		strings.Contains(errStr, "No such container")
}

// SendMessages sends messages to the sandbox.
func (c *SessionClient) SendMessages(ctx context.Context, messages json.RawMessage, model string, opts *RequestOptions) (<-chan SSELine, error) {
	return withReconciliation(ctx, c, func() (<-chan SSELine, error) {
		return c.inner.SendMessages(ctx, c.sessionID, messages, model, opts)
	})
}

// GetStream returns a channel of SSE events for an in-progress completion.
func (c *SessionClient) GetStream(ctx context.Context, opts *RequestOptions) (<-chan SSELine, error) {
	return withReconciliation(ctx, c, func() (<-chan SSELine, error) {
		return c.inner.GetStream(ctx, c.sessionID, opts)
	})
}

// GetMessages retrieves message history from the sandbox.
func (c *SessionClient) GetMessages(ctx context.Context, opts *RequestOptions) ([]sandboxapi.UIMessage, error) {
	return withReconciliation(ctx, c, func() ([]sandboxapi.UIMessage, error) {
		return c.inner.GetMessages(ctx, c.sessionID, opts)
	})
}

// GetChatStatus retrieves the completion status from the sandbox.
func (c *SessionClient) GetChatStatus(ctx context.Context) (*sandboxapi.ChatStatusResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.ChatStatusResponse, error) {
		return c.inner.GetChatStatus(ctx, c.sessionID)
	})
}

// CancelCompletion cancels an in-progress completion in the sandbox.
func (c *SessionClient) CancelCompletion(ctx context.Context) (*CancelCompletionResponse, error) {
	return withReconciliation(ctx, c, func() (*CancelCompletionResponse, error) {
		return c.inner.CancelCompletion(ctx, c.sessionID)
	})
}

// ListFiles lists directory contents in the sandbox.
func (c *SessionClient) ListFiles(ctx context.Context, path string, includeHidden bool) (*sandboxapi.ListFilesResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.ListFilesResponse, error) {
		return c.inner.ListFiles(ctx, c.sessionID, path, includeHidden)
	})
}

// ReadFile reads file content from the sandbox.
func (c *SessionClient) ReadFile(ctx context.Context, path string) (*sandboxapi.ReadFileResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.ReadFileResponse, error) {
		return c.inner.ReadFile(ctx, c.sessionID, path)
	})
}

// WriteFile writes file content to the sandbox.
func (c *SessionClient) WriteFile(ctx context.Context, req *sandboxapi.WriteFileRequest) (*sandboxapi.WriteFileResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.WriteFileResponse, error) {
		return c.inner.WriteFile(ctx, c.sessionID, req)
	})
}

// GetDiff retrieves diff information from the sandbox.
func (c *SessionClient) GetDiff(ctx context.Context, path, format string) (any, error) {
	return withReconciliation(ctx, c, func() (any, error) {
		return c.inner.GetDiff(ctx, c.sessionID, path, format)
	})
}

// GetCommits retrieves git format-patch output from the sandbox.
func (c *SessionClient) GetCommits(ctx context.Context, parentCommit string) (*sandboxapi.CommitsResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.CommitsResponse, error) {
		return c.inner.GetCommits(ctx, c.sessionID, parentCommit)
	})
}

// GetUserInfo retrieves the default user info from the sandbox.
func (c *SessionClient) GetUserInfo(ctx context.Context) (*sandboxapi.UserResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.UserResponse, error) {
		return c.inner.GetUserInfo(ctx, c.sessionID)
	})
}

// GetModels retrieves available models from the Claude API via the sandbox.
func (c *SessionClient) GetModels(ctx context.Context) (*sandboxapi.ModelsResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.ModelsResponse, error) {
		return c.inner.GetModels(ctx, c.sessionID)
	})
}

// ListServices retrieves all services from the sandbox.
func (c *SessionClient) ListServices(ctx context.Context) (*sandboxapi.ListServicesResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.ListServicesResponse, error) {
		return c.inner.ListServices(ctx, c.sessionID)
	})
}

// StartService starts a service in the sandbox.
func (c *SessionClient) StartService(ctx context.Context, serviceID string) (*sandboxapi.StartServiceResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.StartServiceResponse, error) {
		return c.inner.StartService(ctx, c.sessionID, serviceID)
	})
}

// StopService stops a service in the sandbox.
func (c *SessionClient) StopService(ctx context.Context, serviceID string) (*sandboxapi.StopServiceResponse, error) {
	return withReconciliation(ctx, c, func() (*sandboxapi.StopServiceResponse, error) {
		return c.inner.StopService(ctx, c.sessionID, serviceID)
	})
}

// GetServiceOutput returns a channel of SSE events for a service's output.
func (c *SessionClient) GetServiceOutput(ctx context.Context, serviceID string) (<-chan SSELine, error) {
	return withReconciliation(ctx, c, func() (<-chan SSELine, error) {
		return c.inner.GetServiceOutput(ctx, c.sessionID, serviceID)
	})
}
