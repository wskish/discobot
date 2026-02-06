package events

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/obot-platform/discobot/server/internal/store"
)

// WaitForJobCompletion waits for a job to complete for a specific resource.
// This provides near-instant notification when the job completes, without polling the database.
// Returns the job status ("completed" or "failed") and any error message.
// Timeout is enforced via the context.
func WaitForJobCompletion(
	ctx context.Context,
	broker *Broker,
	s *store.Store,
	projectID string,
	resourceType string,
	resourceID string,
) (status string, errorMsg string, err error) {
	// First check if a job for this resource already completed
	job, err := s.GetJobByResourceID(ctx, resourceType, resourceID)
	if err != nil && err != store.ErrNotFound {
		return "", "", fmt.Errorf("failed to get job: %w", err)
	}

	// If job exists and is in a terminal state, return immediately
	if job != nil {
		switch job.Status {
		case "completed":
			return "completed", "", nil
		case "failed":
			errMsg := ""
			if job.Error != nil {
				errMsg = *job.Error
			}
			return "failed", errMsg, nil
		}
	}

	// Job is still pending/running or doesn't exist yet - subscribe to events
	sub := broker.Subscribe(projectID)
	defer broker.Unsubscribe(sub)

	// Set up a ticker for periodic database checks as fallback
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	// Wait for job completion
	for {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()

		case event, ok := <-sub.Events:
			if !ok {
				return "", "", fmt.Errorf("event channel closed")
			}

			// Check if this is a job completion event for our session
			if event.Type == EventTypeJobCompleted {
				var data JobCompletedData
				if err := json.Unmarshal(event.Data, &data); err != nil {
					continue // Skip malformed events
				}

				if data.ResourceID == resourceID && data.ResourceType == resourceType {
					// This is our job!
					return data.Status, data.Error, nil
				}
			}

		case <-ticker.C:
			// Periodically check the database in case we missed an event
			// This provides a fallback if events aren't working
			job, err := s.GetJobByResourceID(ctx, resourceType, resourceID)
			if err != nil && err != store.ErrNotFound {
				return "", "", fmt.Errorf("failed to get job: %w", err)
			}

			if job != nil {
				switch job.Status {
				case "completed":
					return "completed", "", nil
				case "failed":
					errMsg := ""
					if job.Error != nil {
						errMsg = *job.Error
					}
					return "failed", errMsg, nil
				}
			}
		}
	}
}
