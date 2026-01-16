package dispatcher

import "github.com/obot-platform/octobot/server/internal/jobs"

// ConcurrencyLimits defines max concurrent jobs per type.
// These can be made configurable via config.Config if needed.
var ConcurrencyLimits = map[jobs.JobType]int{
	jobs.JobTypeSessionInit:   2, // Max 2 session inits at once
	jobs.JobTypeSessionDelete: 2, // Max 2 session deletes at once
}

// DefaultConcurrencyLimit is used for job types not in ConcurrencyLimits.
const DefaultConcurrencyLimit = 1

// GetConcurrencyLimit returns the concurrency limit for a job type.
// Returns DefaultConcurrencyLimit if not explicitly configured.
func GetConcurrencyLimit(jobType jobs.JobType) int {
	if limit, ok := ConcurrencyLimits[jobType]; ok {
		return limit
	}
	return DefaultConcurrencyLimit
}
