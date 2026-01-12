package dispatcher

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// testDB creates a temporary SQLite database for testing.
// Each test gets its own database file for isolation.
func testDB(t *testing.T) *store.Store {
	// Use a unique temp file for each test to ensure isolation
	tmpFile := fmt.Sprintf("%s/dispatcher_test_%d.db", t.TempDir(), time.Now().UnixNano())
	db, err := gorm.Open(sqlite.Open(tmpFile), &gorm.Config{})
	if err != nil {
		t.Fatalf("Failed to open test database: %v", err)
	}

	// Migrate models
	if err := db.AutoMigrate(model.AllModels()...); err != nil {
		t.Fatalf("Failed to migrate test database: %v", err)
	}

	return store.New(db)
}

// testConfig returns a config with fast intervals for testing.
func testConfig() *config.Config {
	return &config.Config{
		DispatcherEnabled:           true,
		DispatcherPollInterval:      50 * time.Millisecond,
		DispatcherHeartbeatInterval: 100 * time.Millisecond,
		DispatcherHeartbeatTimeout:  500 * time.Millisecond,
		DispatcherJobTimeout:        5 * time.Second,
		DispatcherStaleJobTimeout:   10 * time.Minute,
	}
}

// mockExecutor is a simple executor for testing.
type mockExecutor struct {
	jobType   model.JobType
	executed  int64
	execFunc  func(ctx context.Context, job *model.Job) error
	mu        sync.Mutex
	execCount int
}

func newMockExecutor(jobType model.JobType) *mockExecutor {
	return &mockExecutor{
		jobType: jobType,
		execFunc: func(ctx context.Context, job *model.Job) error {
			return nil
		},
	}
}

func (e *mockExecutor) Type() model.JobType {
	return e.jobType
}

func (e *mockExecutor) Execute(ctx context.Context, job *model.Job) error {
	atomic.AddInt64(&e.executed, 1)
	e.mu.Lock()
	e.execCount++
	e.mu.Unlock()
	return e.execFunc(ctx, job)
}

func (e *mockExecutor) ExecuteCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.execCount
}

// --- JobQueue Tests ---

func TestJobQueue_EnqueueContainerCreate(t *testing.T) {
	s := testDB(t)
	q := NewJobQueue(s)

	ctx := context.Background()
	sessionID := "test-session-1"
	workspacePath := "/home/user/workspace"

	err := q.EnqueueContainerCreate(ctx, sessionID, workspacePath)
	if err != nil {
		t.Fatalf("EnqueueContainerCreate failed: %v", err)
	}

	// Verify job was created
	job, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "test-worker")
	if err != nil {
		t.Fatalf("ClaimJob failed: %v", err)
	}
	if job == nil {
		t.Fatal("Expected job to be created")
	}

	// Verify payload
	var payload model.ContainerCreatePayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		t.Fatalf("Failed to unmarshal payload: %v", err)
	}
	if payload.SessionID != sessionID {
		t.Errorf("Expected sessionID %s, got %s", sessionID, payload.SessionID)
	}
	if payload.WorkspacePath != workspacePath {
		t.Errorf("Expected workspacePath %s, got %s", workspacePath, payload.WorkspacePath)
	}
}

func TestJobQueue_EnqueueContainerDestroy(t *testing.T) {
	s := testDB(t)
	q := NewJobQueue(s)

	ctx := context.Background()
	sessionID := "test-session-1"

	err := q.EnqueueContainerDestroy(ctx, sessionID)
	if err != nil {
		t.Fatalf("EnqueueContainerDestroy failed: %v", err)
	}

	// Verify job was created
	job, err := s.ClaimJob(ctx, string(model.JobTypeContainerDestroy), "test-worker")
	if err != nil {
		t.Fatalf("ClaimJob failed: %v", err)
	}
	if job == nil {
		t.Fatal("Expected job to be created")
	}

	// Verify payload
	var payload model.ContainerDestroyPayload
	if err := json.Unmarshal(job.Payload, &payload); err != nil {
		t.Fatalf("Failed to unmarshal payload: %v", err)
	}
	if payload.SessionID != sessionID {
		t.Errorf("Expected sessionID %s, got %s", sessionID, payload.SessionID)
	}
}

func TestJobQueue_EnqueueWithOptions(t *testing.T) {
	s := testDB(t)
	q := NewJobQueue(s)

	ctx := context.Background()

	type testPayload struct {
		Data string `json:"data"`
	}

	err := q.Enqueue(ctx, model.JobTypeContainerCreate, testPayload{Data: "test"},
		WithPriority(10),
		WithMaxAttempts(5),
	)
	if err != nil {
		t.Fatalf("Enqueue failed: %v", err)
	}

	// Verify job was created with options
	job, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "test-worker")
	if err != nil {
		t.Fatalf("ClaimJob failed: %v", err)
	}
	if job == nil {
		t.Fatal("Expected job to be created")
	}

	if job.Priority != 10 {
		t.Errorf("Expected priority 10, got %d", job.Priority)
	}
	if job.MaxAttempts != 5 {
		t.Errorf("Expected maxAttempts 5, got %d", job.MaxAttempts)
	}
}

// --- Store Job Tests ---

func TestStore_CreateAndClaimJob(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// Create a job
	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     []byte(`{"session_id": "test"}`),
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob failed: %v", err)
	}

	// Claim the job
	claimed, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")
	if err != nil {
		t.Fatalf("ClaimJob failed: %v", err)
	}
	if claimed == nil {
		t.Fatal("Expected job to be claimed")
	}
	if claimed.Status != string(model.JobStatusRunning) {
		t.Errorf("Expected status %s, got %s", model.JobStatusRunning, claimed.Status)
	}
	if claimed.WorkerID == nil || *claimed.WorkerID != "worker-1" {
		t.Error("Expected worker_id to be set")
	}
	if claimed.Attempts != 1 {
		t.Errorf("Expected attempts 1, got %d", claimed.Attempts)
	}

	// Try to claim again - should return nil (no jobs available)
	claimed2, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-2")
	if err != nil {
		t.Fatalf("Second ClaimJob failed: %v", err)
	}
	if claimed2 != nil {
		t.Error("Expected no job to be available")
	}
}

func TestStore_CompleteJob(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     []byte(`{}`),
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob failed: %v", err)
	}

	claimed, _ := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")

	if err := s.CompleteJob(ctx, claimed.ID); err != nil {
		t.Fatalf("CompleteJob failed: %v", err)
	}

	completed, err := s.GetJobByID(ctx, claimed.ID)
	if err != nil {
		t.Fatalf("GetJobByID failed: %v", err)
	}
	if completed.Status != string(model.JobStatusCompleted) {
		t.Errorf("Expected status %s, got %s", model.JobStatusCompleted, completed.Status)
	}
	if completed.CompletedAt == nil {
		t.Error("Expected completed_at to be set")
	}
}

func TestStore_FailJob_WithRetry(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     []byte(`{}`),
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob failed: %v", err)
	}

	claimed, _ := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")

	if err := s.FailJob(ctx, claimed.ID, "test error"); err != nil {
		t.Fatalf("FailJob failed: %v", err)
	}

	// Job should be requeued (attempts=1 < maxAttempts=3)
	failed, err := s.GetJobByID(ctx, claimed.ID)
	if err != nil {
		t.Fatalf("GetJobByID failed: %v", err)
	}
	if failed.Status != string(model.JobStatusPending) {
		t.Errorf("Expected status %s, got %s", model.JobStatusPending, failed.Status)
	}
	if failed.Error == nil || *failed.Error != "test error" {
		t.Error("Expected error message to be set")
	}
	if failed.WorkerID != nil {
		t.Error("Expected worker_id to be cleared")
	}
}

func TestStore_FailJob_MaxAttempts(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     []byte(`{}`),
		Status:      string(model.JobStatusPending),
		MaxAttempts: 1, // Only 1 attempt allowed
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob failed: %v", err)
	}

	claimed, _ := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")

	if err := s.FailJob(ctx, claimed.ID, "final error"); err != nil {
		t.Fatalf("FailJob failed: %v", err)
	}

	// Job should be permanently failed (attempts=1 >= maxAttempts=1)
	failed, err := s.GetJobByID(ctx, claimed.ID)
	if err != nil {
		t.Fatalf("GetJobByID failed: %v", err)
	}
	if failed.Status != string(model.JobStatusFailed) {
		t.Errorf("Expected status %s, got %s", model.JobStatusFailed, failed.Status)
	}
	if failed.CompletedAt == nil {
		t.Error("Expected completed_at to be set")
	}
}

func TestStore_CleanupStaleJobs(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// Create a job and claim it
	job := &model.Job{
		Type:        string(model.JobTypeContainerCreate),
		Payload:     []byte(`{}`),
		Status:      string(model.JobStatusPending),
		MaxAttempts: 3,
	}
	if err := s.CreateJob(ctx, job); err != nil {
		t.Fatalf("CreateJob failed: %v", err)
	}

	claimed, _ := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")

	// Manually backdate the started_at timestamp
	s.DB().Model(&model.Job{}).Where("id = ?", claimed.ID).
		Update("started_at", time.Now().Add(-15*time.Minute))

	// Cleanup stale jobs (stale after 10 minutes)
	count, err := s.CleanupStaleJobs(ctx, 10*time.Minute)
	if err != nil {
		t.Fatalf("CleanupStaleJobs failed: %v", err)
	}
	if count != 1 {
		t.Errorf("Expected 1 stale job, got %d", count)
	}

	// Job should be back to pending
	reset, err := s.GetJobByID(ctx, claimed.ID)
	if err != nil {
		t.Fatalf("GetJobByID failed: %v", err)
	}
	if reset.Status != string(model.JobStatusPending) {
		t.Errorf("Expected status %s, got %s", model.JobStatusPending, reset.Status)
	}
	if reset.WorkerID != nil {
		t.Error("Expected worker_id to be cleared")
	}
}

// --- Job Ordering Tests ---

func TestStore_ClaimJob_OrdersByPriorityThenScheduledAtThenCreatedAt(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	now := time.Now()

	// Create jobs with different priorities, scheduled_at, and created_at times
	// We manually set these to control the ordering
	jobs := []struct {
		name        string
		priority    int
		scheduledAt time.Time
		createdAt   time.Time
	}{
		// Should be claimed 4th: lowest priority
		{"low-priority", 0, now.Add(-10 * time.Minute), now.Add(-10 * time.Minute)},
		// Should be claimed 1st: highest priority
		{"high-priority", 10, now.Add(-5 * time.Minute), now.Add(-5 * time.Minute)},
		// Should be claimed 2nd: medium priority, older scheduled_at
		{"medium-priority-old", 5, now.Add(-20 * time.Minute), now.Add(-20 * time.Minute)},
		// Should be claimed 3rd: medium priority, newer scheduled_at
		{"medium-priority-new", 5, now.Add(-5 * time.Minute), now.Add(-5 * time.Minute)},
	}

	for _, j := range jobs {
		job := &model.Job{
			Type:        string(model.JobTypeContainerCreate),
			Payload:     []byte(`{"session_id": "` + j.name + `"}`),
			Status:      string(model.JobStatusPending),
			Priority:    j.priority,
			ScheduledAt: j.scheduledAt,
			MaxAttempts: 3,
		}
		if err := s.CreateJob(ctx, job); err != nil {
			t.Fatalf("CreateJob failed: %v", err)
		}
		// Manually set created_at (GORM autoCreateTime would set it to now)
		s.DB().Model(&model.Job{}).Where("id = ?", job.ID).Update("created_at", j.createdAt)
	}

	// Claim jobs and verify order
	expectedOrder := []string{"high-priority", "medium-priority-old", "medium-priority-new", "low-priority"}
	for i, expectedName := range expectedOrder {
		claimed, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")
		if err != nil {
			t.Fatalf("ClaimJob %d failed: %v", i, err)
		}
		if claimed == nil {
			t.Fatalf("Expected job %d to be claimed", i)
		}

		var payload model.ContainerCreatePayload
		if err := json.Unmarshal(claimed.Payload, &payload); err != nil {
			t.Fatalf("Failed to unmarshal payload: %v", err)
		}
		if payload.SessionID != expectedName {
			t.Errorf("Job %d: expected %s, got %s", i, expectedName, payload.SessionID)
		}
	}

	// No more jobs should be available
	claimed, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")
	if err != nil {
		t.Fatalf("Final ClaimJob failed: %v", err)
	}
	if claimed != nil {
		t.Error("Expected no more jobs to be available")
	}
}

func TestStore_ClaimJob_CreatedAtTiebreaker(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	now := time.Now()
	scheduledAt := now.Add(-10 * time.Minute)

	// Create jobs with same priority and scheduled_at, but different created_at
	// This tests that created_at is used as a tiebreaker for insertion order
	jobs := []struct {
		name      string
		createdAt time.Time
	}{
		{"third", now.Add(-1 * time.Minute)},  // Created most recently
		{"first", now.Add(-10 * time.Minute)}, // Created earliest
		{"second", now.Add(-5 * time.Minute)}, // Created in middle
	}

	for _, j := range jobs {
		job := &model.Job{
			Type:        string(model.JobTypeContainerCreate),
			Payload:     []byte(`{"session_id": "` + j.name + `"}`),
			Status:      string(model.JobStatusPending),
			Priority:    0, // Same priority
			ScheduledAt: scheduledAt,
			MaxAttempts: 3,
		}
		if err := s.CreateJob(ctx, job); err != nil {
			t.Fatalf("CreateJob failed: %v", err)
		}
		// Manually set created_at
		s.DB().Model(&model.Job{}).Where("id = ?", job.ID).Update("created_at", j.createdAt)
	}

	// Claim jobs - should come out in created_at order (oldest first)
	expectedOrder := []string{"first", "second", "third"}
	for i, expectedName := range expectedOrder {
		claimed, err := s.ClaimJob(ctx, string(model.JobTypeContainerCreate), "worker-1")
		if err != nil {
			t.Fatalf("ClaimJob %d failed: %v", i, err)
		}
		if claimed == nil {
			t.Fatalf("Expected job %d to be claimed", i)
		}

		var payload model.ContainerCreatePayload
		if err := json.Unmarshal(claimed.Payload, &payload); err != nil {
			t.Fatalf("Failed to unmarshal payload: %v", err)
		}
		if payload.SessionID != expectedName {
			t.Errorf("Job %d: expected %s, got %s", i, expectedName, payload.SessionID)
		}
	}
}

// --- Leader Election Tests ---

func TestStore_TryAcquireLeadership_NoLeader(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	acquired, err := s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if err != nil {
		t.Fatalf("TryAcquireLeadership failed: %v", err)
	}
	if !acquired {
		t.Error("Expected to acquire leadership when no leader exists")
	}
}

func TestStore_TryAcquireLeadership_SameServer(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// First acquisition
	acquired, err := s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if err != nil || !acquired {
		t.Fatalf("First TryAcquireLeadership failed: err=%v, acquired=%v", err, acquired)
	}

	// Same server tries again (heartbeat update)
	acquired, err = s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if err != nil {
		t.Fatalf("Second TryAcquireLeadership failed: %v", err)
	}
	if !acquired {
		t.Error("Same server should maintain leadership")
	}
}

func TestStore_TryAcquireLeadership_DifferentServer_ActiveLeader(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// Server 1 acquires leadership
	acquired, err := s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if err != nil || !acquired {
		t.Fatalf("Server-1 TryAcquireLeadership failed: err=%v, acquired=%v", err, acquired)
	}

	// Server 2 tries to acquire (should fail - server 1's heartbeat is fresh)
	acquired, err = s.TryAcquireLeadership(ctx, "server-2", 30*time.Second)
	if err != nil {
		t.Fatalf("Server-2 TryAcquireLeadership failed: %v", err)
	}
	if acquired {
		t.Error("Server-2 should not acquire leadership while server-1 is active")
	}
}

func TestStore_TryAcquireLeadership_ExpiredHeartbeat(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// Server 1 acquires leadership
	acquired, err := s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if err != nil || !acquired {
		t.Fatalf("Server-1 TryAcquireLeadership failed: err=%v, acquired=%v", err, acquired)
	}

	// Manually backdate the heartbeat
	s.DB().Model(&model.DispatcherLeader{}).
		Where("id = ?", model.DispatcherLeaderSingletonID).
		Update("heartbeat_at", time.Now().Add(-1*time.Minute))

	// Server 2 tries to acquire (should succeed - server 1's heartbeat expired)
	acquired, err = s.TryAcquireLeadership(ctx, "server-2", 30*time.Second)
	if err != nil {
		t.Fatalf("Server-2 TryAcquireLeadership failed: %v", err)
	}
	if !acquired {
		t.Error("Server-2 should acquire leadership after server-1's heartbeat expired")
	}
}

func TestStore_ReleaseLeadership(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	// Acquire leadership
	acquired, _ := s.TryAcquireLeadership(ctx, "server-1", 30*time.Second)
	if !acquired {
		t.Fatal("Failed to acquire leadership")
	}

	// Release leadership
	if err := s.ReleaseLeadership(ctx, "server-1"); err != nil {
		t.Fatalf("ReleaseLeadership failed: %v", err)
	}

	// Server 2 should now be able to acquire immediately
	acquired, err := s.TryAcquireLeadership(ctx, "server-2", 30*time.Second)
	if err != nil {
		t.Fatalf("Server-2 TryAcquireLeadership failed: %v", err)
	}
	if !acquired {
		t.Error("Server-2 should acquire leadership after server-1 released")
	}
}

// --- Dispatcher Service Tests ---

func TestDispatcher_RegisterExecutor(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	executor := newMockExecutor(model.JobTypeContainerCreate)
	d.RegisterExecutor(executor)

	if _, ok := d.executors[model.JobTypeContainerCreate]; !ok {
		t.Error("Executor not registered")
	}
}

func TestDispatcher_ServerID(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	if d.ServerID() == "" {
		t.Error("ServerID should not be empty")
	}
}

func TestDispatcher_StartStop(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	executor := newMockExecutor(model.JobTypeContainerCreate)
	d.RegisterExecutor(executor)

	ctx := context.Background()
	d.Start(ctx)

	// Wait a bit for leader election
	time.Sleep(200 * time.Millisecond)

	if !d.IsLeader() {
		t.Error("Dispatcher should become leader")
	}

	d.Stop()

	// After stop, leadership should be released
	// Note: checking isLeader state after stop might be racy,
	// so we just verify it doesn't hang
}

func TestDispatcher_ProcessesJobs(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	var executedJobs int64
	executor := newMockExecutor(model.JobTypeContainerCreate)
	executor.execFunc = func(ctx context.Context, job *model.Job) error {
		atomic.AddInt64(&executedJobs, 1)
		return nil
	}
	d.RegisterExecutor(executor)

	// Enqueue a job before starting the dispatcher
	q := NewJobQueue(s)
	if err := q.EnqueueContainerCreate(context.Background(), "session-1", "/workspace"); err != nil {
		t.Fatalf("EnqueueContainerCreate failed: %v", err)
	}

	// Start dispatcher
	ctx := context.Background()
	d.Start(ctx)

	// Wait for job to be processed
	time.Sleep(500 * time.Millisecond)

	if atomic.LoadInt64(&executedJobs) != 1 {
		t.Errorf("Expected 1 job to be executed, got %d", executedJobs)
	}

	d.Stop()
}

func TestDispatcher_RespectsJobTimeout(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	cfg.DispatcherJobTimeout = 100 * time.Millisecond

	d := NewService(s, cfg)

	var jobTimedOut int64
	executor := newMockExecutor(model.JobTypeContainerCreate)
	executor.execFunc = func(ctx context.Context, job *model.Job) error {
		// Simulate a slow job that respects context cancellation
		select {
		case <-ctx.Done():
			atomic.AddInt64(&jobTimedOut, 1)
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
			return nil
		}
	}
	d.RegisterExecutor(executor)

	// Enqueue a job
	q := NewJobQueue(s)
	q.EnqueueContainerCreate(context.Background(), "session-1", "/workspace")

	// Start dispatcher
	ctx := context.Background()
	d.Start(ctx)

	// Wait for job to be processed (and timed out)
	time.Sleep(300 * time.Millisecond)

	d.Stop()

	// Verify the job was cancelled due to timeout
	if atomic.LoadInt64(&jobTimedOut) != 1 {
		t.Error("Expected job to be cancelled due to timeout")
	}

	// Query the job to verify its state
	var jobs []model.Job
	s.DB().Where("type = ?", model.JobTypeContainerCreate).Find(&jobs)
	if len(jobs) != 1 {
		t.Fatalf("Expected 1 job, got %d", len(jobs))
	}

	// Job should be requeued for retry (pending) since it failed with timeout
	// and attempts < maxAttempts, or still running if timing is off
	status := jobs[0].Status
	if status != string(model.JobStatusPending) && status != string(model.JobStatusRunning) {
		t.Errorf("Expected job status pending or running (retry), got %s", status)
	}
}

func TestDispatcher_ConcurrencyLimit(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	var maxConcurrent int64
	var currentConcurrent int64
	var mu sync.Mutex

	executor := newMockExecutor(model.JobTypeContainerCreate)
	executor.execFunc = func(ctx context.Context, job *model.Job) error {
		mu.Lock()
		currentConcurrent++
		if currentConcurrent > maxConcurrent {
			maxConcurrent = currentConcurrent
		}
		mu.Unlock()

		time.Sleep(100 * time.Millisecond)

		mu.Lock()
		currentConcurrent--
		mu.Unlock()
		return nil
	}
	d.RegisterExecutor(executor)

	// Enqueue more jobs than the concurrency limit
	q := NewJobQueue(s)
	for i := 0; i < 10; i++ {
		q.EnqueueContainerCreate(context.Background(), fmt.Sprintf("session-%d", i), "/workspace")
	}

	// Start dispatcher
	ctx := context.Background()
	d.Start(ctx)

	// Wait for jobs to process
	time.Sleep(2 * time.Second)

	limit := GetConcurrencyLimit(model.JobTypeContainerCreate)
	if maxConcurrent > int64(limit) {
		t.Errorf("Max concurrent jobs (%d) exceeded limit (%d)", maxConcurrent, limit)
	}

	d.Stop()
}

func TestDispatcher_MultipleJobTypes(t *testing.T) {
	s := testDB(t)
	cfg := testConfig()
	d := NewService(s, cfg)

	var createJobs, destroyJobs int64

	createExecutor := newMockExecutor(model.JobTypeContainerCreate)
	createExecutor.execFunc = func(ctx context.Context, job *model.Job) error {
		atomic.AddInt64(&createJobs, 1)
		return nil
	}

	destroyExecutor := newMockExecutor(model.JobTypeContainerDestroy)
	destroyExecutor.execFunc = func(ctx context.Context, job *model.Job) error {
		atomic.AddInt64(&destroyJobs, 1)
		return nil
	}

	d.RegisterExecutor(createExecutor)
	d.RegisterExecutor(destroyExecutor)

	// Enqueue both types of jobs
	q := NewJobQueue(s)
	q.EnqueueContainerCreate(context.Background(), "session-1", "/workspace")
	q.EnqueueContainerDestroy(context.Background(), "session-2")
	q.EnqueueContainerCreate(context.Background(), "session-3", "/workspace")

	// Start dispatcher
	ctx := context.Background()
	d.Start(ctx)

	// Wait for jobs to process
	time.Sleep(500 * time.Millisecond)

	if atomic.LoadInt64(&createJobs) != 2 {
		t.Errorf("Expected 2 create jobs, got %d", createJobs)
	}
	if atomic.LoadInt64(&destroyJobs) != 1 {
		t.Errorf("Expected 1 destroy job, got %d", destroyJobs)
	}

	d.Stop()
}

// --- Concurrency Limits Tests ---

func TestGetConcurrencyLimit(t *testing.T) {
	tests := []struct {
		jobType  model.JobType
		expected int
	}{
		{model.JobTypeContainerCreate, ConcurrencyLimits[model.JobTypeContainerCreate]},
		{model.JobTypeContainerDestroy, ConcurrencyLimits[model.JobTypeContainerDestroy]},
		{model.JobType("unknown"), DefaultConcurrencyLimit},
	}

	for _, tt := range tests {
		t.Run(string(tt.jobType), func(t *testing.T) {
			got := GetConcurrencyLimit(tt.jobType)
			if got != tt.expected {
				t.Errorf("GetConcurrencyLimit(%s) = %d, want %d", tt.jobType, got, tt.expected)
			}
		})
	}
}
