package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/service"
)

// ContainerDestroyExecutor handles container_destroy jobs.
type ContainerDestroyExecutor struct {
	containerService *service.ContainerService
}

// NewContainerDestroyExecutor creates a new container destroy executor.
func NewContainerDestroyExecutor(cs *service.ContainerService) *ContainerDestroyExecutor {
	return &ContainerDestroyExecutor{containerService: cs}
}

// Type returns the job type this executor handles.
func (e *ContainerDestroyExecutor) Type() model.JobType {
	return model.JobTypeContainerDestroy
}

// Execute processes the job.
func (e *ContainerDestroyExecutor) Execute(ctx context.Context, job *model.Job) error {
	if e.containerService == nil {
		return fmt.Errorf("container service not available")
	}

	var payload model.ContainerDestroyPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}

	if payload.SessionID == "" {
		return fmt.Errorf("session_id is required")
	}

	return e.containerService.DestroyForSession(ctx, payload.SessionID)
}
