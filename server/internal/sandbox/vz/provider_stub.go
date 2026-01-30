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
)

// Config holds vz-specific configuration.
type Config struct {
	DataDir      string
	KernelPath   string
	InitrdPath   string
	BaseDiskPath string
}

// Provider is a stub that returns an error on non-darwin platforms.
type Provider struct{}

// NewProvider returns an error on non-darwin platforms.
func NewProvider(_ *config.Config, _ *Config) (*Provider, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS (darwin), current platform: %s", runtime.GOOS)
}

// ImageExists always returns false on non-darwin platforms.
func (p *Provider) ImageExists(_ context.Context) bool {
	return false
}

// Image returns empty string on non-darwin platforms.
func (p *Provider) Image() string {
	return ""
}

// Create returns an error on non-darwin platforms.
func (p *Provider) Create(_ context.Context, _ string, _ sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Start returns an error on non-darwin platforms.
func (p *Provider) Start(_ context.Context, _ string) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Stop returns an error on non-darwin platforms.
func (p *Provider) Stop(_ context.Context, _ string, _ time.Duration) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Remove returns an error on non-darwin platforms.
func (p *Provider) Remove(_ context.Context, _ string, _ ...sandbox.RemoveOption) error {
	return fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Get returns an error on non-darwin platforms.
func (p *Provider) Get(_ context.Context, _ string) (*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// GetSecret returns an error on non-darwin platforms.
func (p *Provider) GetSecret(_ context.Context, _ string) (string, error) {
	return "", fmt.Errorf("vz sandbox provider is only available on macOS")
}

// List returns an error on non-darwin platforms.
func (p *Provider) List(_ context.Context) ([]*sandbox.Sandbox, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Exec returns an error on non-darwin platforms.
func (p *Provider) Exec(_ context.Context, _ string, _ []string, _ sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Attach returns an error on non-darwin platforms.
func (p *Provider) Attach(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// ExecStream returns an error on non-darwin platforms.
func (p *Provider) ExecStream(_ context.Context, _ string, _ []string, _ sandbox.ExecStreamOptions) (sandbox.Stream, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// HTTPClient returns an error on non-darwin platforms.
func (p *Provider) HTTPClient(_ context.Context, _ string) (*http.Client, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Watch returns an error on non-darwin platforms.
func (p *Provider) Watch(_ context.Context) (<-chan sandbox.StateEvent, error) {
	return nil, fmt.Errorf("vz sandbox provider is only available on macOS")
}

// Close is a no-op on non-darwin platforms.
func (p *Provider) Close() error {
	return nil
}
