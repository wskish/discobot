// Package dispatcher provides a database-backed job queue with leader election.
package dispatcher

import (
	"context"

	"github.com/anthropics/octobot/server/internal/model"
)

// JobExecutor defines the interface for executing a specific job type.
type JobExecutor interface {
	// Type returns the job type this executor handles.
	Type() model.JobType

	// Execute processes the job. Returns error on failure.
	Execute(ctx context.Context, job *model.Job) error
}
