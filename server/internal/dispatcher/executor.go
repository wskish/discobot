// Package dispatcher provides a database-backed job queue with leader election.
package dispatcher

import (
	"context"

	"github.com/obot-platform/octobot/server/internal/jobs"
	"github.com/obot-platform/octobot/server/internal/model"
)

// JobExecutor defines the interface for executing a specific job type.
type JobExecutor interface {
	// Type returns the job type this executor handles.
	Type() jobs.JobType

	// Execute processes the job. Returns error on failure.
	Execute(ctx context.Context, job *model.Job) error
}
