package model

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// JobStatus represents the current state of a job.
type JobStatus string

const (
	JobStatusPending   JobStatus = "pending"
	JobStatusRunning   JobStatus = "running"
	JobStatusCompleted JobStatus = "completed"
	JobStatusFailed    JobStatus = "failed"
)

// JobType represents the type of job.
type JobType string

const (
	JobTypeContainerCreate  JobType = "container_create"
	JobTypeContainerDestroy JobType = "container_destroy"
)

// Job represents a background job in the queue.
type Job struct {
	ID          string          `gorm:"primaryKey;type:text" json:"id"`
	Type        string          `gorm:"not null;type:text;index:idx_job_status_type" json:"type"`
	Payload     json.RawMessage `gorm:"type:text;not null" json:"payload"`
	Status      string          `gorm:"not null;type:text;default:pending;index:idx_job_status_type" json:"status"`
	Priority    int             `gorm:"not null;default:0;index" json:"priority"`
	Attempts    int             `gorm:"not null;default:0" json:"attempts"`
	MaxAttempts int             `gorm:"column:max_attempts;not null;default:3" json:"max_attempts"`
	Error       *string         `gorm:"type:text" json:"error,omitempty"`
	WorkerID    *string         `gorm:"column:worker_id;type:text" json:"worker_id,omitempty"`
	ScheduledAt time.Time       `gorm:"column:scheduled_at;not null;index" json:"scheduled_at"`
	StartedAt   *time.Time      `gorm:"column:started_at" json:"started_at,omitempty"`
	CompletedAt *time.Time      `gorm:"column:completed_at" json:"completed_at,omitempty"`
	CreatedAt   time.Time       `gorm:"autoCreateTime" json:"created_at"`
	UpdatedAt   time.Time       `gorm:"autoUpdateTime" json:"updated_at"`
}

// TableName returns the table name for Job.
func (Job) TableName() string { return "jobs" }

// BeforeCreate generates a UUID if not set.
func (j *Job) BeforeCreate(tx *gorm.DB) error {
	if j.ID == "" {
		j.ID = uuid.New().String()
	}
	if j.ScheduledAt.IsZero() {
		j.ScheduledAt = time.Now()
	}
	if j.Status == "" {
		j.Status = string(JobStatusPending)
	}
	return nil
}

// ContainerCreatePayload is the payload for container_create jobs.
type ContainerCreatePayload struct {
	SessionID     string `json:"session_id"`
	WorkspacePath string `json:"workspace_path"`
}

// ContainerDestroyPayload is the payload for container_destroy jobs.
type ContainerDestroyPayload struct {
	SessionID string `json:"session_id"`
}
