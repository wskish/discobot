//go:build darwin

package vz

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/obot-platform/discobot/server/internal/sandbox"
)

const (
	// stateSubdir is the subdirectory within dataDir for state files.
	stateSubdir = "state"
)

// vmState is the persistent state for a VM instance.
// This is saved to disk and reloaded on server restart.
type vmState struct {
	SessionID       string            `json:"session_id"`
	DiskPath        string            `json:"disk_path"`
	Secret          string            `json:"secret"`
	Status          sandbox.Status    `json:"status"`
	CreatedAt       time.Time         `json:"created_at"`
	StartedAt       *time.Time        `json:"started_at,omitempty"`
	StoppedAt       *time.Time        `json:"stopped_at,omitempty"`
	Env             map[string]string `json:"env,omitempty"`
	Metadata        map[string]string `json:"metadata,omitempty"`
	WorkspacePath   string            `json:"workspace_path,omitempty"`
	WorkspaceCommit string            `json:"workspace_commit,omitempty"`
}

// stateFilePath returns the path to the state file for a session.
func (p *Provider) stateFilePath(sessionID string) string {
	return filepath.Join(p.dataDir, stateSubdir, fmt.Sprintf("%s.json", sessionID))
}

// saveState persists the VM state to disk.
func (p *Provider) saveState(instance *vmInstance) error {
	instance.mu.RLock()
	state := vmState{
		SessionID: instance.sessionID,
		DiskPath:  instance.diskPath,
		Secret:    instance.secret,
		Status:    instance.status,
		CreatedAt: instance.createdAt,
		StartedAt: instance.startedAt,
		StoppedAt: instance.stoppedAt,
		Env:       instance.env,
		Metadata:  instance.metadata,
	}
	if instance.metadata != nil {
		state.WorkspacePath = instance.metadata["workspace.path"]
		state.WorkspaceCommit = instance.metadata["workspace.commit"]
	}
	instance.mu.RUnlock()

	// Ensure state directory exists
	stateDir := filepath.Join(p.dataDir, stateSubdir)
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return fmt.Errorf("failed to create state directory: %w", err)
	}

	// Write state to temp file first, then rename (atomic)
	statePath := p.stateFilePath(state.SessionID)
	tempPath := statePath + ".tmp"

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}

	if err := os.WriteFile(tempPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}

	if err := os.Rename(tempPath, statePath); err != nil {
		os.Remove(tempPath)
		return fmt.Errorf("failed to rename state file: %w", err)
	}

	return nil
}

// loadState loads a VM state from disk.
func (p *Provider) loadState(sessionID string) (*vmState, error) {
	statePath := p.stateFilePath(sessionID)

	data, err := os.ReadFile(statePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read state file: %w", err)
	}

	var state vmState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}

	return &state, nil
}

// deleteState removes the state file for a session.
func (p *Provider) deleteState(sessionID string) error {
	statePath := p.stateFilePath(sessionID)
	err := os.Remove(statePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete state file: %w", err)
	}
	return nil
}

// loadAllStates loads all persisted VM states from disk.
// VMs that were running when the server stopped are marked as stopped
// since VMs don't survive host process restarts.
func (p *Provider) loadAllStates() ([]*vmState, error) {
	stateDir := filepath.Join(p.dataDir, stateSubdir)

	// Create state directory if it doesn't exist
	if err := os.MkdirAll(stateDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create state directory: %w", err)
	}

	entries, err := os.ReadDir(stateDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read state directory: %w", err)
	}

	var states []*vmState
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		// Skip temp files
		if filepath.Ext(entry.Name()) == ".tmp" {
			continue
		}

		sessionID := entry.Name()[:len(entry.Name())-5] // Remove .json extension

		state, err := p.loadState(sessionID)
		if err != nil {
			// Log error but continue loading other states
			continue
		}
		if state == nil {
			continue
		}

		// VMs that were running are now stopped (process died)
		if state.Status == sandbox.StatusRunning {
			now := time.Now()
			state.Status = sandbox.StatusStopped
			state.StoppedAt = &now
		}

		states = append(states, state)
	}

	return states, nil
}

// recoverFromState creates a vmInstance from persisted state.
// The VM itself is not running - only the metadata is restored.
func (p *Provider) recoverFromState(state *vmState) *vmInstance {
	return &vmInstance{
		diskPath:  state.DiskPath,
		sessionID: state.SessionID,
		secret:    state.Secret,
		status:    state.Status,
		createdAt: state.CreatedAt,
		startedAt: state.StartedAt,
		stoppedAt: state.StoppedAt,
		env:       state.Env,
		metadata:  state.Metadata,
		// vm, config, socketDevice, consoleRead, consoleWrite are nil
		// until Start() is called
	}
}
