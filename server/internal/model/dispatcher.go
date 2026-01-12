package model

import (
	"time"
)

// DispatcherLeaderSingletonID is the ID used for the single leadership row.
const DispatcherLeaderSingletonID = "singleton"

// DispatcherLeader represents leadership for job processing.
// Only one row should exist with ID="singleton" - uses upsert pattern.
type DispatcherLeader struct {
	ID          string    `gorm:"primaryKey;type:text" json:"id"`
	ServerID    string    `gorm:"column:server_id;not null;type:text" json:"server_id"`
	HeartbeatAt time.Time `gorm:"column:heartbeat_at;not null" json:"heartbeat_at"`
	AcquiredAt  time.Time `gorm:"column:acquired_at;not null" json:"acquired_at"`
}

// TableName returns the table name for DispatcherLeader.
func (DispatcherLeader) TableName() string { return "dispatcher_leaders" }
