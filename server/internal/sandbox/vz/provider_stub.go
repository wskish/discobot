//go:build !darwin

// Package vz provides a macOS Virtualization.framework-based implementation of the sandbox.Provider interface.
// This stub file is used on non-darwin platforms where the vz library is not available.
package vz

import (
	"context"
	"fmt"
	"net/http"
	"runtime"
	"time"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/vm"
)

// SessionProjectResolver looks up the project ID for a session from the database.
// Returns the project ID or an error if the session doesn't exist.
type SessionProjectResolver func(ctx context.Context, sessionID string) (projectID string, err error)

// DockerProvider is a stub that returns an error on non-darwin platforms.
type DockerProvider struct{}

// NewProvider returns an error on non-darwin platforms.
func NewProvider(_ *config.Config, _ *vm.Config, _ SessionProjectResolver) (*DockerProvider, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS (darwin), current platform: %s", runtime.GOOS)
}

// ImageExists always returns false on non-darwin platforms.
func (p *DockerProvider) ImageExists(_ context.Context) bool {
	return false
}

// Image returns empty string on non-darwin platforms.
func (p *DockerProvider) Image() string {
	return ""
}

// Create returns an error on non-darwin platforms.
func (p *DockerProvider) Create(_ context.Context, _ string, _ sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Start returns an error on non-darwin platforms.
func (p *DockerProvider) Start(_ context.Context, _ string) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Stop returns an error on non-darwin platforms.
func (p *DockerProvider) Stop(_ context.Context, _ string, _ time.Duration) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Remove returns an error on non-darwin platforms.
func (p *DockerProvider) Remove(_ context.Context, _ string, _ ...sandbox.RemoveOption) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Get returns an error on non-darwin platforms.
func (p *DockerProvider) Get(_ context.Context, _ string) (*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// GetSecret returns an error on non-darwin platforms.
func (p *DockerProvider) GetSecret(_ context.Context, _ string) (string, error) {
	return "", fmt.Errorf("vz sandbox provider is only available on macOS")
}

// List returns an error on non-darwin platforms.
func (p *DockerProvider) List(_ context.Context) ([]*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Exec returns an error on non-darwin platforms.
func (p *DockerProvider) Exec(_ context.Context, _ string, _ []string, _ sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Attach returns an error on non-darwin platforms.
func (p *DockerProvider) Attach(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// ExecStream returns an error on non-darwin platforms.
func (p *DockerProvider) ExecStream(_ context.Context, _ string, _ []string, _ sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// HTTPClient returns an error on non-darwin platforms.
func (p *DockerProvider) HTTPClient(_ context.Context, _ string) (*http.Client, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Watch returns an error on non-darwin platforms.
func (p *DockerProvider) Watch(_ context.Context) (<-chan sandbox.StateEvent, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Close is a no-op on non-darwin platforms.
func (p *DockerProvider) Close() error {
	return nil
}

// Status returns not available status on non-darwin platforms.
func (p *DockerProvider) Status() sandbox.ProviderStatus {
	return sandbox.ProviderStatus{
		Available: false,
		State:     "not_available",
		Message:   fmt.Sprintf("VZ provider is only available on macOS ARM64, current platform: %s/%s", runtime.GOOS, runtime.GOARCH),
	}
}

// IsReady always returns false on non-darwin platforms.
func (p *DockerProvider) IsReady() bool {
	return false
}

// WarmVM is a no-op on non-darwin platforms.
func (p *DockerProvider) WarmVM(_ context.Context, _ string) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// WaitForReady is a no-op on non-darwin platforms.
func (p *DockerProvider) WaitForReady(_ context.Context) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}
