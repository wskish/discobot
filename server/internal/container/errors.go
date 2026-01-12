package container

import "errors"

// Sentinel errors for container operations.
var (
	// ErrNotFound indicates the container does not exist.
	ErrNotFound = errors.New("container not found")

	// ErrAlreadyExists indicates a container already exists for the session.
	ErrAlreadyExists = errors.New("container already exists for session")

	// ErrNotRunning indicates the container is not running when it should be.
	ErrNotRunning = errors.New("container not running")

	// ErrAlreadyRunning indicates the container is already running.
	ErrAlreadyRunning = errors.New("container already running")

	// ErrStartFailed indicates the container failed to start.
	ErrStartFailed = errors.New("container failed to start")

	// ErrExecFailed indicates command execution failed.
	ErrExecFailed = errors.New("command execution failed")

	// ErrAttachFailed indicates failed to attach to container PTY.
	ErrAttachFailed = errors.New("failed to attach to container")

	// ErrTimeout indicates the operation timed out.
	ErrTimeout = errors.New("operation timed out")

	// ErrInvalidImage indicates the container image is invalid or not found.
	ErrInvalidImage = errors.New("invalid container image")

	// ErrResourceLimit indicates a resource limit was exceeded.
	ErrResourceLimit = errors.New("resource limit exceeded")
)
