package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/service"
)

// SessionCommitExecutor handles session_commit jobs.
type SessionCommitExecutor struct {
	sessionService *service.SessionService
}

// NewSessionCommitExecutor creates a new session commit executor.
func NewSessionCommitExecutor(sessionSvc *service.SessionService) *SessionCommitExecutor {
	return &SessionCommitExecutor{sessionService: sessionSvc}
}

// Type returns the job type this executor handles.
func (e *SessionCommitExecutor) Type() JobType {
	return JobTypeSessionCommit
}

// Execute processes the job.
func (e *SessionCommitExecutor) Execute(ctx context.Context, job *model.Job) error {
	if e.sessionService == nil {
		return fmt.Errorf("session service not available")
	}

	var payload SessionCommitPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.SessionID == "" {
		return fmt.Errorf("sessionId is required")
	}
	if payload.ProjectID == "" {
		return fmt.Errorf("projectId is required")
	}

	return e.sessionService.PerformCommit(ctx, payload.ProjectID, payload.SessionID)
}
