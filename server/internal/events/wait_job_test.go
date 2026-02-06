package events

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/obot-platform/discobot/server/internal/model"
)

func TestWaitForJobCompletion_AlreadyCompleted(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 1 * time.Second, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Create a completed job in the database
	job := &model.Job{
		Type:         "session_init",
		Status:       "completed",
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("test-session"),
		Payload:      []byte(`{"projectId":"test-project","sessionId":"test-session"}`),
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("Failed to create job: %v", err)
	}

	// Test
	status, errMsg, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, "session", "test-session")

	// Assert
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}
	if status != "completed" {
		t.Errorf("Expected status 'completed', got: %s", status)
	}
	if errMsg != "" {
		t.Errorf("Expected empty error message, got: %s", errMsg)
	}
}

func TestWaitForJobCompletion_AlreadyFailed(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 1 * time.Second, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Create a failed job in the database
	errorMsg := "initialization failed"
	job := &model.Job{
		Type:         "session_init",
		Status:       "failed",
		Error:        &errorMsg,
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("test-session"),
		Payload:      []byte(`{"projectId":"test-project","sessionId":"test-session"}`),
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("Failed to create job: %v", err)
	}

	// Test
	status, retErrMsg, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, "session", "test-session")

	// Assert
	if err != nil {
		t.Errorf("Expected no error, got: %v", err)
	}
	if status != "failed" {
		t.Errorf("Expected status 'failed', got: %s", status)
	}
	if retErrMsg != errorMsg {
		t.Errorf("Expected error message '%s', got: %s", errorMsg, retErrMsg)
	}
}

func TestWaitForJobCompletion_WaitForEvent(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 100 * time.Millisecond, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Create a pending job in the database
	job := &model.Job{
		Type:         "session_init",
		Status:       "pending",
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("test-session"),
		Payload:      []byte(`{"projectId":"test-project","sessionId":"test-session"}`),
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("Failed to create job: %v", err)
	}

	// Start waiting in a goroutine
	resultCh := make(chan struct {
		status string
		errMsg string
		err    error
	})
	go func() {
		status, errMsg, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, "session", "test-session")
		resultCh <- struct {
			status string
			errMsg string
			err    error
		}{status, errMsg, err}
	}()

	// Simulate job completion by publishing an event after a short delay
	time.Sleep(100 * time.Millisecond)
	if err := broker.PublishJobCompleted(ctx, env.ProjectID, job.ID, "session_init", "session", "test-session", "completed", ""); err != nil {
		t.Fatalf("Failed to publish job completed event: %v", err)
	}

	// Wait for result with timeout
	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Errorf("Expected no error, got: %v", result.err)
		}
		if result.status != "completed" {
			t.Errorf("Expected status 'completed', got: %s", result.status)
		}
		if result.errMsg != "" {
			t.Errorf("Expected empty error message, got: %s", result.errMsg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Timeout waiting for job completion")
	}
}

func TestWaitForJobCompletion_Timeout(t *testing.T) {
	// Setup
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 1 * time.Second, BatchSize: 100})
	if err := eventPoller.Start(context.Background()); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Create a pending job that never completes
	job := &model.Job{
		Type:         "session_init",
		Status:       "pending",
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("test-session"),
		Payload:      []byte(`{"projectId":"test-project","sessionId":"test-session"}`),
	}
	if err := s.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("Failed to create job: %v", err)
	}

	// Test
	_, _, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, "session", "test-session")

	// Assert
	if err != context.DeadlineExceeded {
		t.Errorf("Expected DeadlineExceeded error, got: %v", err)
	}
}

func TestWaitForJobCompletion_DifferentResourceTypes(t *testing.T) {
	testCases := []struct {
		name         string
		resourceType string
		resourceID   string
	}{
		{"session", "session", "session-123"},
		{"workspace", "workspace", "workspace-456"},
		{"project", "project", "project-789"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Setup
			ctx := context.Background()
			env := testSetup(t)
			defer env.Cleanup()
			s := env.Store
			eventPoller := NewPoller(s, PollerConfig{PollInterval: 1 * time.Second, BatchSize: 100})
			if err := eventPoller.Start(ctx); err != nil {
				t.Fatalf("Failed to start event poller: %v", err)
			}
			defer eventPoller.Stop()

			broker := NewBroker(s, eventPoller)

			// Create a completed job
			job := &model.Job{
				Type:         "test_job",
				Status:       "completed",
				ResourceType: &tc.resourceType,
				ResourceID:   &tc.resourceID,
				Payload:      []byte(`{}`),
			}
			if err := s.CreateJob(ctx, job); err != nil {
				t.Fatalf("Failed to create job: %v", err)
			}

			// Test
			status, _, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, tc.resourceType, tc.resourceID)

			// Assert
			if err != nil {
				t.Errorf("Expected no error, got: %v", err)
			}
			if status != "completed" {
				t.Errorf("Expected status 'completed', got: %s", status)
			}
		})
	}
}

func TestWaitForJobCompletion_EventFiltering(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 100 * time.Millisecond, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Create two pending jobs
	job1 := &model.Job{
		Type:         "session_init",
		Status:       "pending",
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("session-1"),
		Payload:      []byte(`{}`),
	}
	job2 := &model.Job{
		Type:         "session_init",
		Status:       "pending",
		ResourceType: ptrString("session"),
		ResourceID:   ptrString("session-2"),
		Payload:      []byte(`{}`),
	}
	if err := s.CreateJob(ctx, job1); err != nil {
		t.Fatalf("Failed to create job1: %v", err)
	}
	if err := s.CreateJob(ctx, job2); err != nil {
		t.Fatalf("Failed to create job2: %v", err)
	}

	// Start waiting for session-2
	resultCh := make(chan struct {
		status string
		errMsg string
		err    error
	})
	go func() {
		status, errMsg, err := WaitForJobCompletion(ctx, broker, s, env.ProjectID, "session", "session-2")
		resultCh <- struct {
			status string
			errMsg string
			err    error
		}{status, errMsg, err}
	}()

	// Publish completion for session-1 first (should be ignored)
	time.Sleep(50 * time.Millisecond)
	if err := broker.PublishJobCompleted(ctx, env.ProjectID, job1.ID, "session_init", "session", "session-1", "completed", ""); err != nil {
		t.Fatalf("Failed to publish job1 completed event: %v", err)
	}

	// Then publish completion for session-2 (should be caught)
	time.Sleep(50 * time.Millisecond)
	if err := broker.PublishJobCompleted(ctx, env.ProjectID, job2.ID, "session_init", "session", "session-2", "completed", ""); err != nil {
		t.Fatalf("Failed to publish job2 completed event: %v", err)
	}

	// Wait for result
	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Errorf("Expected no error, got: %v", result.err)
		}
		if result.status != "completed" {
			t.Errorf("Expected status 'completed', got: %s", result.status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Timeout waiting for job completion")
	}
}

func TestPublishJobCompleted(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 100 * time.Millisecond, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Subscribe to events
	sub := broker.Subscribe(env.ProjectID)
	defer broker.Unsubscribe(sub)

	// Test publishing job completed event
	err := broker.PublishJobCompleted(ctx, env.ProjectID, "job-123", "session_init", "session", "session-456", "completed", "")
	if err != nil {
		t.Fatalf("Failed to publish job completed event: %v", err)
	}

	// Wait for event
	select {
	case event := <-sub.Events:
		if event.Type != EventTypeJobCompleted {
			t.Errorf("Expected EventTypeJobCompleted, got: %s", event.Type)
		}

		var data JobCompletedData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("Failed to unmarshal event data: %v", err)
		}

		if data.JobID != "job-123" {
			t.Errorf("Expected JobID 'job-123', got: %s", data.JobID)
		}
		if data.JobType != "session_init" {
			t.Errorf("Expected JobType 'session_init', got: %s", data.JobType)
		}
		if data.ResourceType != "session" {
			t.Errorf("Expected ResourceType 'session', got: %s", data.ResourceType)
		}
		if data.ResourceID != "session-456" {
			t.Errorf("Expected ResourceID 'session-456', got: %s", data.ResourceID)
		}
		if data.Status != "completed" {
			t.Errorf("Expected Status 'completed', got: %s", data.Status)
		}
		if data.Error != "" {
			t.Errorf("Expected empty Error, got: %s", data.Error)
		}

	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for job completed event")
	}
}

func TestPublishJobCompleted_WithError(t *testing.T) {
	// Setup
	ctx := context.Background()
	env := testSetup(t)
	defer env.Cleanup()
	s := env.Store
	eventPoller := NewPoller(s, PollerConfig{PollInterval: 100 * time.Millisecond, BatchSize: 100})
	if err := eventPoller.Start(ctx); err != nil {
		t.Fatalf("Failed to start event poller: %v", err)
	}
	defer eventPoller.Stop()

	broker := NewBroker(s, eventPoller)

	// Subscribe to events
	sub := broker.Subscribe(env.ProjectID)
	defer broker.Unsubscribe(sub)

	// Test publishing failed job event
	err := broker.PublishJobCompleted(ctx, env.ProjectID, "job-789", "session_init", "session", "session-fail", "failed", "initialization error")
	if err != nil {
		t.Fatalf("Failed to publish job completed event: %v", err)
	}

	// Wait for event
	select {
	case event := <-sub.Events:
		var data JobCompletedData
		if err := json.Unmarshal(event.Data, &data); err != nil {
			t.Fatalf("Failed to unmarshal event data: %v", err)
		}

		if data.Status != "failed" {
			t.Errorf("Expected Status 'failed', got: %s", data.Status)
		}
		if data.Error != "initialization error" {
			t.Errorf("Expected Error 'initialization error', got: %s", data.Error)
		}

	case <-time.After(2 * time.Second):
		t.Fatal("Timeout waiting for job completed event")
	}
}

func ptrString(s string) *string {
	return &s
}
