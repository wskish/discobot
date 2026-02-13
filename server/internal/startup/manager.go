// Package startup provides a system-wide startup task manager for tracking
// long-running operations that happen on server startup (VZ image download,
// Docker image pulls, VM warming, etc.)
package startup

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/obot-platform/discobot/server/internal/events"
)

const (
	// EventTypeStartupTaskUpdated indicates a startup task's state has changed
	EventTypeStartupTaskUpdated events.EventType = "startup_task_updated"
)

// TaskState represents the state of a startup task
type TaskState string

const (
	TaskStatePending    TaskState = "pending"
	TaskStateInProgress TaskState = "in_progress"
	TaskStateCompleted  TaskState = "completed"
	TaskStateFailed     TaskState = "failed"
)

// Task represents a startup task being tracked
type Task struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	State            TaskState  `json:"state"`
	Progress         *int       `json:"progress,omitempty"` // 0-100
	CurrentOperation string     `json:"currentOperation,omitempty"`
	BytesDownloaded  *int64     `json:"bytesDownloaded,omitempty"`
	TotalBytes       *int64     `json:"totalBytes,omitempty"`
	Error            string     `json:"error,omitempty"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	CompletedAt      *time.Time `json:"completedAt,omitempty"`
}

// SystemManager tracks all startup tasks and system status, broadcasting updates via SSE
type SystemManager struct {
	tasks      map[string]*Task
	tasksMu    sync.RWMutex
	broker     *events.Broker
	projectID  string // Which project to emit events for (usually "local")
	emitEvents bool   // Whether to emit SSE events
}

// NewSystemManager creates a new system manager
func NewSystemManager(broker *events.Broker, projectID string) *SystemManager {
	return &SystemManager{
		tasks:      make(map[string]*Task),
		broker:     broker,
		projectID:  projectID,
		emitEvents: broker != nil,
	}
}

// RegisterTask creates a new task in pending state
func (m *SystemManager) RegisterTask(id, name string) {
	m.tasksMu.Lock()
	defer m.tasksMu.Unlock()

	task := &Task{
		ID:    id,
		Name:  name,
		State: TaskStatePending,
	}
	m.tasks[id] = task
}

// StartTask marks a task as in progress
func (m *SystemManager) StartTask(id string) {
	m.updateTask(id, func(task *Task) {
		task.State = TaskStateInProgress
		now := time.Now()
		task.StartedAt = &now
	})
}

// UpdateTaskProgress updates task progress and current operation
func (m *SystemManager) UpdateTaskProgress(id string, progress int, currentOperation string) {
	m.updateTask(id, func(task *Task) {
		task.Progress = &progress
		task.CurrentOperation = currentOperation
	})
}

// UpdateTaskBytes updates byte download progress
func (m *SystemManager) UpdateTaskBytes(id string, bytesDownloaded, totalBytes int64) {
	m.updateTask(id, func(task *Task) {
		task.BytesDownloaded = &bytesDownloaded
		task.TotalBytes = &totalBytes

		// Calculate progress percentage
		if totalBytes > 0 {
			progress := int(float64(bytesDownloaded) / float64(totalBytes) * 100)
			task.Progress = &progress
		}
	})
}

// CompleteTask marks a task as completed
func (m *SystemManager) CompleteTask(id string) {
	m.updateTask(id, func(task *Task) {
		task.State = TaskStateCompleted
		now := time.Now()
		task.CompletedAt = &now
		progress := 100
		task.Progress = &progress
	})
}

// FailTask marks a task as failed with an error message
func (m *SystemManager) FailTask(id string, err error) {
	m.updateTask(id, func(task *Task) {
		task.State = TaskStateFailed
		task.Error = err.Error()
		now := time.Now()
		task.CompletedAt = &now
	})
}

// updateTask applies an update function to a task and emits an SSE event
func (m *SystemManager) updateTask(id string, updateFn func(*Task)) {
	m.tasksMu.Lock()
	defer m.tasksMu.Unlock()

	task, exists := m.tasks[id]
	if !exists {
		return
	}

	updateFn(task)

	// Emit SSE event
	if m.emitEvents {
		go m.emitTaskUpdate(task)
	}
}

// emitTaskUpdate sends an SSE event for a task update
func (m *SystemManager) emitTaskUpdate(task *Task) {
	taskJSON, err := json.Marshal(task)
	if err != nil {
		return
	}

	event := &events.Event{
		ID:        generateEventID(),
		Type:      EventTypeStartupTaskUpdated,
		Timestamp: time.Now(),
		Data:      taskJSON,
	}

	// Use a short timeout to avoid blocking
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_ = m.broker.Publish(ctx, m.projectID, event)
}

// GetTasks returns all current tasks
func (m *SystemManager) GetTasks() []*Task {
	m.tasksMu.RLock()
	defer m.tasksMu.RUnlock()

	tasks := make([]*Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		// Create a copy to avoid race conditions
		taskCopy := *task
		tasks = append(tasks, &taskCopy)
	}
	return tasks
}

// GetTask returns a specific task by ID
func (m *SystemManager) GetTask(id string) (*Task, bool) {
	m.tasksMu.RLock()
	defer m.tasksMu.RUnlock()

	task, exists := m.tasks[id]
	if !exists {
		return nil, false
	}

	// Return a copy
	taskCopy := *task
	return &taskCopy, true
}

// HasActiveTasks returns true if any tasks are pending or in progress
func (m *SystemManager) HasActiveTasks() bool {
	m.tasksMu.RLock()
	defer m.tasksMu.RUnlock()

	for _, task := range m.tasks {
		if task.State == TaskStatePending || task.State == TaskStateInProgress {
			return true
		}
	}
	return false
}

// StatusMessageLevel represents the severity level of a status message
type StatusMessageLevel string

const (
	StatusLevelWarn  StatusMessageLevel = "warn"
	StatusLevelError StatusMessageLevel = "error"
)

// StatusMessage represents a system status check message
type StatusMessage struct {
	ID      string             `json:"id"`
	Level   StatusMessageLevel `json:"level"`
	Title   string             `json:"title"`
	Message string             `json:"message"`
}

// SystemStatusResponse represents the complete system status
type SystemStatusResponse struct {
	OK           bool            `json:"ok"`
	Messages     []StatusMessage `json:"messages"`
	StartupTasks []*Task         `json:"startupTasks,omitempty"`
}

// GetSystemStatus checks system requirements and returns complete status
func (m *SystemManager) GetSystemStatus() SystemStatusResponse {
	var messages []StatusMessage

	// Check for Git
	if _, err := exec.LookPath("git"); err != nil {
		messages = append(messages, StatusMessage{
			ID:      "git-not-found",
			Level:   StatusLevelWarn,
			Title:   "Git not found",
			Message: "Git is required for version control features. Please install Git to enable repository management.",
		})
	}

	// Check for Docker (only required on Linux and Windows; macOS uses VZ)
	if runtime.GOOS != "darwin" {
		if _, err := exec.LookPath("docker"); err != nil {
			messages = append(messages, StatusMessage{
				ID:      "docker-not-found",
				Level:   StatusLevelWarn,
				Title:   "Docker not found",
				Message: "Docker is required for running coding agents in isolated containers. Please install Docker to enable agent execution.",
			})
		}
	}

	// Determine if system is OK (no error-level messages)
	ok := true
	for _, msg := range messages {
		if msg.Level == StatusLevelError {
			ok = false
			break
		}
	}

	return SystemStatusResponse{
		OK:           ok,
		Messages:     messages,
		StartupTasks: m.GetTasks(),
	}
}

// generateEventID generates a unique event ID based on the current timestamp
func generateEventID() string {
	return time.Now().Format("20060102150405.000000000")
}
