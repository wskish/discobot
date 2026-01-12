package dispatcher

import (
	"context"
	"encoding/json"

	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// JobQueue provides helper methods for enqueueing jobs.
type JobQueue struct {
	store      *store.Store
	notifyFunc func() // Called after job creation to notify dispatcher
}

// NewJobQueue creates a new job queue helper.
func NewJobQueue(s *store.Store) *JobQueue {
	return &JobQueue{store: s}
}

// SetNotifyFunc sets the function to call after job creation.
// This is typically dispatcher.NotifyNewJob.
func (q *JobQueue) SetNotifyFunc(f func()) {
	q.notifyFunc = f
}

// notify calls the notify function if set.
func (q *JobQueue) notify() {
	if q.notifyFunc != nil {
		q.notifyFunc()
	}
}

// EnqueueContainerCreate enqueues a container_create job.
func (q *JobQueue) EnqueueContainerCreate(ctx context.Context, sessionID, workspacePath string) error {
	payload, err := json.Marshal(model.ContainerCreatePayload{
		SessionID:     sessionID,
		WorkspacePath: workspacePath,
	})
	if err != nil {
		return err
	}

	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     payload,
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// EnqueueContainerDestroy enqueues a container_destroy job.
func (q *JobQueue) EnqueueContainerDestroy(ctx context.Context, sessionID string) error {
	payload, err := json.Marshal(model.ContainerDestroyPayload{
		SessionID: sessionID,
	})
	if err != nil {
		return err
	}

	job := &model.Job{
		Type:        string(model.JobTypeContainerDestroy),
		Payload:     payload,
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// Enqueue enqueues a generic job with the given type and payload.
func (q *JobQueue) Enqueue(ctx context.Context, jobType model.JobType, payload interface{}, opts ...JobOption) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	job := &model.Job{
		Type:        string(jobType),
		Payload:     payloadBytes,
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}

	// Apply options
	for _, opt := range opts {
		opt(job)
	}

	if err := q.store.CreateJob(ctx, job); err != nil {
		return err
	}
	q.notify()
	return nil
}

// JobOption is a function that configures a job.
type JobOption func(*model.Job)

// WithPriority sets the job priority (higher = processed first).
func WithPriority(priority int) JobOption {
	return func(j *model.Job) {
		j.Priority = priority
	}
}

// WithMaxAttempts sets the maximum number of retry attempts.
func WithMaxAttempts(attempts int) JobOption {
	return func(j *model.Job) {
		j.MaxAttempts = attempts
	}
}
