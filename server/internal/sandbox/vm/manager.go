// Package vm provides an abstraction for project-level virtual machine management.
// Different implementations (VZ, KVM, WSL2) can provide VMs that run Docker daemon
// for container-based session isolation.
package vm

import (
	"context"
	"net"
)

// ProjectVM represents a VM instance that hosts Docker daemon for multiple sessions.
type ProjectVM interface {
	// ProjectID returns the project ID this VM serves.
	ProjectID() string

	// AddSession registers a session with this VM.
	AddSession(sessionID string)

	// RemoveSession unregisters a session from this VM.
	RemoveSession(sessionID string)

	// SessionCount returns the number of active sessions using this VM.
	SessionCount() int

	// DockerDialer returns a dialer function for connecting to Docker daemon inside the VM.
	// The dialer is used to create a Docker client with custom transport.
	DockerDialer() func(ctx context.Context, network, addr string) (net.Conn, error)

	// Shutdown gracefully stops the VM.
	Shutdown() error
}

// ProjectVMManager manages project-level VMs.
// Each implementation (VZ, KVM, WSL2) provides VMs that run Docker daemon,
// allowing multiple sessions within a project to share a VM while maintaining
// isolation via Docker containers.
type ProjectVMManager interface {
	// GetOrCreateVM returns an existing VM for the project or creates a new one.
	// The sessionID is registered with the returned VM for reference counting.
	GetOrCreateVM(ctx context.Context, projectID, sessionID string) (ProjectVM, error)

	// GetVM returns the VM for the given project, if it exists.
	GetVM(projectID string) (ProjectVM, bool)

	// RemoveSession removes a session from the project VM.
	// The VM may be shut down based on idle timeout policies.
	RemoveSession(projectID, sessionID string) error

	// Shutdown stops all VMs and cleans up resources.
	Shutdown()
}

// Config contains common configuration for VM managers.
type Config struct {
	// DataDir is where VM disk images and state are stored.
	DataDir string

	// ConsoleLogDir is where VM console logs are written.
	// Each project VM writes to {ConsoleLogDir}/project-{projectID}/console.log
	// Example: "~/.local/state/discobot/vz" for XDG compliance
	ConsoleLogDir string

	// KernelPath is the path to the Linux kernel (for VZ, KVM).
	KernelPath string

	// InitrdPath is the path to the initial ramdisk (optional).
	InitrdPath string

	// BaseDiskPath is the path to the base disk image to clone.
	// The base image should have Docker daemon pre-installed.
	BaseDiskPath string

	// IdleTimeout is how long to wait before shutting down idle VMs.
	// Zero means VMs are never shut down automatically.
	IdleTimeout string

	// CPUCount is the number of CPUs per VM (0 = default).
	CPUCount int

	// MemoryMB is the memory per VM in megabytes (0 = default).
	MemoryMB int
}
