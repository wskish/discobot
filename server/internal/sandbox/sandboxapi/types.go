// Package sandboxapi defines the request/response types for the sandbox HTTP API.
//
// These types must be kept in sync with the TypeScript agent's API types
// located at: agent/src/api/types.ts
//
// API Endpoints:
//
//	GET  /        - Health check
//	GET  /health  - Detailed health status
//	GET  /chat    - Get all messages
//	POST /chat    - Send messages and stream response (SSE)
//	DELETE /chat  - Clear session and messages
package sandboxapi

import "encoding/json"

// ============================================================================
// Request Types
// ============================================================================

// ChatRequest is the POST /chat request body.
type ChatRequest struct {
	// Messages is the array of UIMessages to send.
	// Kept as raw JSON to pass through without requiring Go to understand
	// the full UIMessage structure from the AI SDK.
	Messages json.RawMessage `json:"messages"`
}

// ============================================================================
// Response Types
// ============================================================================

// RootResponse is the GET / response.
type RootResponse struct {
	Status  string `json:"status"`  // Always "ok"
	Service string `json:"service"` // Always "agent"
}

// HealthResponse is the GET /health response.
type HealthResponse struct {
	Healthy   bool `json:"healthy"`
	Connected bool `json:"connected"`
}

// UserResponse is the GET /user response.
type UserResponse struct {
	Username string `json:"username"`
	UID      int    `json:"uid"`
	GID      int    `json:"gid"`
}

// GetMessagesResponse is the GET /chat response.
type GetMessagesResponse struct {
	Messages []UIMessage `json:"messages"`
}

// ClearSessionResponse is the DELETE /chat response.
type ClearSessionResponse struct {
	Success bool `json:"success"`
}

// ChatStatusResponse is the GET /chat/status response.
type ChatStatusResponse struct {
	IsRunning    bool    `json:"isRunning"`
	CompletionID *string `json:"completionId"`
	StartedAt    *string `json:"startedAt"`
	Error        *string `json:"error"`
}

// ErrorResponse is returned for 4xx/5xx errors.
type ErrorResponse struct {
	Error string `json:"error"`
}

// ============================================================================
// Shared Types
// ============================================================================

// UIMessage represents a message in AI SDK UIMessage format.
// This is a minimal representation - the full structure is passed through
// as raw JSON where possible to avoid tight coupling with AI SDK internals.
type UIMessage struct {
	ID        string          `json:"id"`
	Role      string          `json:"role"` // "user", "assistant", "system"
	Parts     json.RawMessage `json:"parts"`
	CreatedAt string          `json:"createdAt,omitempty"`
}

// ============================================================================
// File System Types
// ============================================================================

// FileEntry represents a single file or directory entry.
type FileEntry struct {
	Name string `json:"name"`
	Type string `json:"type"` // "file" or "directory"
	Size int64  `json:"size,omitempty"`
}

// ListFilesResponse is the GET /files response.
type ListFilesResponse struct {
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
}

// ReadFileResponse is the GET /files/read response.
type ReadFileResponse struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // "utf8" or "base64"
	Size     int64  `json:"size"`
}

// WriteFileRequest is the POST /files/write request body.
type WriteFileRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	Encoding string `json:"encoding,omitempty"` // defaults to "utf8"
}

// WriteFileResponse is the POST /files/write response.
type WriteFileResponse struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// FileDiffEntry represents a single changed file in the diff.
type FileDiffEntry struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // "added", "modified", "deleted", "renamed"
	OldPath   string `json:"oldPath,omitempty"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
	Patch     string `json:"patch,omitempty"`
}

// DiffStats contains summary statistics for a diff.
type DiffStats struct {
	FilesChanged int `json:"filesChanged"`
	Additions    int `json:"additions"`
	Deletions    int `json:"deletions"`
}

// DiffResponse is the GET /diff response (full diff with patches).
type DiffResponse struct {
	Files []FileDiffEntry `json:"files"`
	Stats DiffStats       `json:"stats"`
}

// DiffFileEntry represents a file entry with status for the files-only diff response.
type DiffFileEntry struct {
	Path    string `json:"path"`
	Status  string `json:"status"` // "added", "modified", "deleted", "renamed"
	OldPath string `json:"oldPath,omitempty"`
}

// DiffFilesResponse is the GET /diff?format=files response (file paths with status).
type DiffFilesResponse struct {
	Files []DiffFileEntry `json:"files"`
	Stats DiffStats       `json:"stats"`
}

// SingleFileDiffResponse is the GET /diff?path=... response.
type SingleFileDiffResponse struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // "added", "modified", "deleted", "renamed", "unchanged"
	OldPath   string `json:"oldPath,omitempty"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
	Patch     string `json:"patch"`
}

// ============================================================================
// Git Commits Types (for commit workflow)
// ============================================================================

// CommitsResponse is the GET /commits response (success case).
// Returns git format-patch output for commits since a parent.
type CommitsResponse struct {
	Patches     string `json:"patches"`     // Git format-patch output (mbox format)
	CommitCount int    `json:"commitCount"` // Number of commits in patches
}

// CommitsErrorResponse is the GET /commits error response.
type CommitsErrorResponse struct {
	Error   string `json:"error"`   // "parent_mismatch", "no_commits", "invalid_parent", "not_git_repo"
	Message string `json:"message"` // Human-readable error message
}

// ============================================================================
// Service Types
// ============================================================================

// Service represents a user-defined service in the sandbox.
type Service struct {
	ID          string `json:"id"`                    // Filename in .discobot/services/
	Name        string `json:"name"`                  // Display name (from config or id)
	Description string `json:"description,omitempty"` // Description from config
	HTTP        int    `json:"http,omitempty"`        // HTTP port if http service
	HTTPS       int    `json:"https,omitempty"`       // HTTPS port if https service
	Path        string `json:"path"`                  // Absolute path to service file
	URLPath     string `json:"urlPath,omitempty"`     // Default URL path for web preview (e.g., "/app")
	Status      string `json:"status"`                // "running", "stopped", "starting", "stopping"
	Passive     bool   `json:"passive,omitempty"`     // True if passive service (external HTTP endpoint, not started/stopped)
	PID         int    `json:"pid,omitempty"`         // Process ID if running
	StartedAt   string `json:"startedAt,omitempty"`   // ISO timestamp when started
	ExitCode    *int   `json:"exitCode,omitempty"`    // Exit code if stopped after running
}

// ListServicesResponse is the GET /services response.
type ListServicesResponse struct {
	Services []Service `json:"services"`
}

// StartServiceResponse is the POST /services/:id/start response.
type StartServiceResponse struct {
	Status    string `json:"status"`    // "starting"
	ServiceID string `json:"serviceId"` // The service ID
}

// StopServiceResponse is the POST /services/:id/stop response.
type StopServiceResponse struct {
	Status    string `json:"status"`    // "stopped"
	ServiceID string `json:"serviceId"` // The service ID
}

// ServiceOutputEvent represents a single output event from a service.
type ServiceOutputEvent struct {
	Type      string `json:"type"`               // "stdout", "stderr", "exit", "error"
	Data      string `json:"data,omitempty"`     // Output data for stdout/stderr
	ExitCode  *int   `json:"exitCode,omitempty"` // Exit code for exit event
	Error     string `json:"error,omitempty"`    // Error message for error event
	Timestamp string `json:"timestamp"`          // ISO timestamp
}
