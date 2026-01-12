package dispatcher

import "github.com/anthropics/octobot/server/internal/model"

// ConcurrencyLimits defines max concurrent jobs per type.
// These can be made configurable via config.Config if needed.
var ConcurrencyLimits = map[model.JobType]int{
	model.JobTypeContainerCreate:  2, // Max 2 container creates at once
	model.JobTypeContainerDestroy: 5, // Destroys are fast, allow more
}

// DefaultConcurrencyLimit is used for job types not in ConcurrencyLimits.
const DefaultConcurrencyLimit = 1

// GetConcurrencyLimit returns the concurrency limit for a job type.
// Returns DefaultConcurrencyLimit if not explicitly configured.
func GetConcurrencyLimit(jobType model.JobType) int {
	if limit, ok := ConcurrencyLimits[jobType]; ok {
		return limit
	}
	return DefaultConcurrencyLimit
}
