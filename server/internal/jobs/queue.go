package jobs

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/obot-platform/octobot/server/internal/model"
	"github.com/obot-platform/octobot/server/internal/store"
)

// Queue provides helper methods for enqueueing jobs.
type Queue struct {
	store      *store.Store
	notifyFunc func() // Called after job creation to notify dispatcher
}

// NewQueue creates a new job queue helper.
func NewQueue(s *store.Store) *Queue {
	return &Queue{store: s}
}

// SetNotifyFunc sets the function to call after job creation.
// This is typically dispatcher.NotifyNewJob.
func (q *Queue) SetNotifyFunc(f func()) {
	q.notifyFunc = f
}

// notify calls the notify function if set.
func (q *Queue) notify() {
	if q.notifyFunc != nil {
		q.notifyFunc()
	}
}

// Resource type constants for job deduplication.
const (
	ResourceTypeSession   = "session"
	ResourceTypeWorkspace = "workspace"
)

// ErrJobAlreadyExists is returned when a job for the resource already exists.
var ErrJobAlreadyExists = errors.New("job already exists for resource")

// EnqueueSessionInit enqueues a session_init job.
// Returns ErrJobAlreadyExists if a pending/running job for this session already exists.
func (q *Queue) EnqueueSessionInit(ctx context.Context, projectID, sessionID, workspaceID, agentID string) error {
	// Check for existing pending/running job for this session
	exists, err := q.store.HasActiveJobForResource(ctx, ResourceTypeSession, sessionID)
	if err != nil {
		return err
	}
	if exists {
		return ErrJobAlreadyExists
	}

	payload, err := json.Marshal(SessionInitPayload{
		ProjectID:   projectID,
		SessionID:   sessionID,
		WorkspaceID: workspaceID,
		AgentID:     agentID,
	})
	if err != nil {
		return err
	}

	resourceType := ResourceTypeSession
	job := &model.Job{
		Type:         string(JobTypeSessionInit),
		Payload:      payload,
		Status:       string(model.JobStatusPending),
		MaxAttempts:  3,
		Priority:     10, // Higher priority for session init
		ResourceType: &resourceType,
		ResourceID:   &sessionID,
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// EnqueueWorkspaceInit enqueues a workspace_init job.
// Returns ErrJobAlreadyExists if a pending/running job for this workspace already exists.
func (q *Queue) EnqueueWorkspaceInit(ctx context.Context, projectID, workspaceID string) error {
	// Check for existing pending/running job for this workspace
	exists, err := q.store.HasActiveJobForResource(ctx, ResourceTypeWorkspace, workspaceID)
	if err != nil {
		return err
	}
	if exists {
		return ErrJobAlreadyExists
	}

	payload, err := json.Marshal(WorkspaceInitPayload{
		ProjectID:   projectID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return err
	}

	resourceType := ResourceTypeWorkspace
	job := &model.Job{
		Type:         string(JobTypeWorkspaceInit),
		Payload:      payload,
		Status:       string(model.JobStatusPending),
		MaxAttempts:  3,
		Priority:     10, // Higher priority for workspace init
		ResourceType: &resourceType,
		ResourceID:   &workspaceID,
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// EnqueueSessionDelete enqueues a session_delete job.
// Returns ErrJobAlreadyExists if a pending/running job for this session already exists.
func (q *Queue) EnqueueSessionDelete(ctx context.Context, projectID, sessionID string) error {
	// Check for existing pending/running job for this session
	exists, err := q.store.HasActiveJobForResource(ctx, ResourceTypeSession, sessionID)
	if err != nil {
		return err
	}
	if exists {
		return ErrJobAlreadyExists
	}

	payload, err := json.Marshal(SessionDeletePayload{
		ProjectID: projectID,
		SessionID: sessionID,
	})
	if err != nil {
		return err
	}

	resourceType := ResourceTypeSession
	job := &model.Job{
		Type:         string(JobTypeSessionDelete),
		Payload:      payload,
		Status:       string(model.JobStatusPending),
		MaxAttempts:  3,
		Priority:     5, // Lower priority than init - deletion can wait
		ResourceType: &resourceType,
		ResourceID:   &sessionID,
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}
