package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/service"
)

// ContainerCreateExecutor handles container_create jobs.
type ContainerCreateExecutor struct {
	containerService *service.ContainerService
}

// NewContainerCreateExecutor creates a new container create executor.
func NewContainerCreateExecutor(cs *service.ContainerService) *ContainerCreateExecutor {
	return &ContainerCreateExecutor{containerService: cs}
}

// Type returns the job type this executor handles.
func (e *ContainerCreateExecutor) Type() model.JobType {
	return model.JobTypeContainerCreate
}

// Execute processes the job.
func (e *ContainerCreateExecutor) Execute(ctx context.Context, job *model.Job) error {
	if e.containerService == nil {
		return fmt.Errorf("container service not available")
	}

	var payload model.ContainerCreatePayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.SessionID == "" {
		return fmt.Errorf("session_id is required")
	}

	return e.containerService.CreateForSession(ctx, payload.SessionID, payload.WorkspacePath)
}
