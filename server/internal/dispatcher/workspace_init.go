package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/obot-platform/discobot/server/internal/jobs"
	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/service"
)

// WorkspaceInitExecutor handles workspace_init jobs.
type WorkspaceInitExecutor struct {
	workspaceService *service.WorkspaceService
}

// NewWorkspaceInitExecutor creates a new workspace init executor.
func NewWorkspaceInitExecutor(workspaceSvc *service.WorkspaceService) *WorkspaceInitExecutor {
	return &WorkspaceInitExecutor{workspaceService: workspaceSvc}
}

// Type returns the job type this executor handles.
func (e *WorkspaceInitExecutor) Type() jobs.JobType {
	return jobs.JobTypeWorkspaceInit
}

// Execute processes the job.
func (e *WorkspaceInitExecutor) Execute(ctx context.Context, job *model.Job) error {
	if e.workspaceService == nil {
		return fmt.Errorf("workspace service not available")
	}

	var payload jobs.WorkspaceInitPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.WorkspaceID == "" {
		return fmt.Errorf("workspaceId is required")
	}

	return e.workspaceService.Initialize(ctx, payload.WorkspaceID)
}
