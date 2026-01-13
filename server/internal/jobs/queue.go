package jobs

import (
	"context"
	"encoding/json"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
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

// EnqueueSessionInit enqueues a session_init job.
func (q *Queue) EnqueueSessionInit(ctx context.Context, projectID, sessionID, workspaceID, agentID string) error {
	payload, err := json.Marshal(SessionInitPayload{
		ProjectID:   projectID,
		SessionID:   sessionID,
		WorkspaceID: workspaceID,
		AgentID:     agentID,
	})
	if err != nil {
		return err
	}

	job := &model.Job{
		Type:        string(JobTypeSessionInit),
		Payload:     payload,
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
		Priority:    10, // Higher priority for session init
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// EnqueueWorkspaceInit enqueues a workspace_init job.
func (q *Queue) EnqueueWorkspaceInit(ctx context.Context, projectID, workspaceID string) error {
	payload, err := json.Marshal(WorkspaceInitPayload{
		ProjectID:   projectID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return err
	}

	job := &model.Job{
		Type:        string(JobTypeWorkspaceInit),
		Payload:     payload,
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
		Priority:    10, // Higher priority for workspace init
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}
