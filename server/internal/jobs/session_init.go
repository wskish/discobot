package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/service"
)

// SessionInitExecutor handles session_init jobs.
type SessionInitExecutor struct {
	sessionService *service.SessionService
}

// NewSessionInitExecutor creates a new session init executor.
func NewSessionInitExecutor(sessionSvc *service.SessionService) *SessionInitExecutor {
	return &SessionInitExecutor{sessionService: sessionSvc}
}

// Type returns the job type this executor handles.
func (e *SessionInitExecutor) Type() JobType {
	return JobTypeSessionInit
}

// Execute processes the job.
func (e *SessionInitExecutor) Execute(ctx context.Context, job *model.Job) error {
	if e.sessionService == nil {
		return fmt.Errorf("session service not available")
	}

	var payload SessionInitPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.SessionID == "" {
		return fmt.Errorf("sessionId is required")
	}
	if payload.WorkspaceID == "" {
		return fmt.Errorf("workspaceId is required")
	}

	return e.sessionService.Initialize(ctx, payload.SessionID)
}
