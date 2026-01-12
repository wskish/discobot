// Package mock provides a mock implementation of container.Runtime for testing.
package mock

import (
	"context"
	"io"
	"sync"
	"time"

	"github.com/anthropics/octobot/server/internal/container"
)

// Provider is a mock container runtime for testing.
type Provider struct {
	mu         sync.RWMutex
	containers map[string]*container.Container

	// Configurable behaviors for testing
	CreateFunc func(ctx context.Context, sessionID string, opts container.CreateOptions) (*container.Container, error)
	StartFunc  func(ctx context.Context, sessionID string) error
	StopFunc   func(ctx context.Context, sessionID string, timeout time.Duration) error
	RemoveFunc func(ctx context.Context, sessionID string) error
	GetFunc    func(ctx context.Context, sessionID string) (*container.Container, error)
	ExecFunc   func(ctx context.Context, sessionID string, cmd []string, opts container.ExecOptions) (*container.ExecResult, error)
	AttachFunc func(ctx context.Context, sessionID string, opts container.AttachOptions) (container.PTY, error)
}

// NewProvider creates a new mock provider with default behavior.
func NewProvider() *Provider {
	return &Provider{
		containers: make(map[string]*container.Container),
	}
}

// Create creates a mock container.
func (p *Provider) Create(ctx context.Context, sessionID string, opts container.CreateOptions) (*container.Container, error) {
	if p.CreateFunc != nil {
		return p.CreateFunc(ctx, sessionID, opts)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.containers[sessionID]; exists {
		return nil, container.ErrAlreadyExists
	}

	c := &container.Container{
		ID:        "mock-" + sessionID,
		SessionID: sessionID,
		Status:    container.StatusCreated,
		Image:     opts.Image,
		CreatedAt: time.Now(),
		Metadata:  map[string]string{"mock": "true"},
	}
	p.containers[sessionID] = c
	return c, nil
}

// Start starts a mock container.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	if p.StartFunc != nil {
		return p.StartFunc(ctx, sessionID)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	c, exists := p.containers[sessionID]
	if !exists {
		return container.ErrNotFound
	}

	if c.Status == container.StatusRunning {
		return container.ErrAlreadyRunning
	}

	c.Status = container.StatusRunning
	now := time.Now()
	c.StartedAt = &now
	return nil
}

// Stop stops a mock container.
func (p *Provider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	if p.StopFunc != nil {
		return p.StopFunc(ctx, sessionID, timeout)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	c, exists := p.containers[sessionID]
	if !exists {
		return container.ErrNotFound
	}

	if c.Status != container.StatusRunning {
		return container.ErrNotRunning
	}

	c.Status = container.StatusStopped
	now := time.Now()
	c.StoppedAt = &now
	return nil
}

// Remove removes a mock container.
func (p *Provider) Remove(ctx context.Context, sessionID string) error {
	if p.RemoveFunc != nil {
		return p.RemoveFunc(ctx, sessionID)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.containers[sessionID]; !exists {
		return nil // Idempotent
	}

	delete(p.containers, sessionID)
	return nil
}

// Get returns a mock container.
func (p *Provider) Get(ctx context.Context, sessionID string) (*container.Container, error) {
	if p.GetFunc != nil {
		return p.GetFunc(ctx, sessionID)
	}

	p.mu.RLock()
	defer p.mu.RUnlock()

	c, exists := p.containers[sessionID]
	if !exists {
		return nil, container.ErrNotFound
	}

	// Return a copy
	copy := *c
	return &copy, nil
}

// Exec runs a mock command.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts container.ExecOptions) (*container.ExecResult, error) {
	if p.ExecFunc != nil {
		return p.ExecFunc(ctx, sessionID, cmd, opts)
	}

	p.mu.RLock()
	_, exists := p.containers[sessionID]
	p.mu.RUnlock()

	if !exists {
		return nil, container.ErrNotFound
	}

	return &container.ExecResult{
		ExitCode: 0,
		Stdout:   []byte("mock output\n"),
		Stderr:   []byte{},
	}, nil
}

// Attach creates a mock PTY.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts container.AttachOptions) (container.PTY, error) {
	if p.AttachFunc != nil {
		return p.AttachFunc(ctx, sessionID, opts)
	}

	p.mu.RLock()
	c, exists := p.containers[sessionID]
	p.mu.RUnlock()

	if !exists {
		return nil, container.ErrNotFound
	}

	if c.Status != container.StatusRunning {
		return nil, container.ErrNotRunning
	}

	return &MockPTY{}, nil
}

// GetContainers returns all containers (for test assertions).
func (p *Provider) GetContainers() map[string]*container.Container {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make(map[string]*container.Container)
	for k, v := range p.containers {
		copy := *v
		result[k] = &copy
	}
	return result
}

// MockPTY is a mock PTY for testing.
type MockPTY struct {
	InputBuffer  []byte
	OutputBuffer []byte
	Closed       bool
	ResizeCalls  []struct{ Rows, Cols int }
	mu           sync.Mutex
}

func (p *MockPTY) Read(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.Closed {
		return 0, io.EOF
	}

	if len(p.OutputBuffer) == 0 {
		// Simulate some output
		p.OutputBuffer = []byte("$ ")
	}

	n := copy(b, p.OutputBuffer)
	p.OutputBuffer = p.OutputBuffer[n:]
	return n, nil
}

func (p *MockPTY) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.Closed {
		return 0, io.ErrClosedPipe
	}

	p.InputBuffer = append(p.InputBuffer, b...)
	// Echo input to output
	p.OutputBuffer = append(p.OutputBuffer, b...)
	return len(b), nil
}

func (p *MockPTY) Resize(rows, cols int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.ResizeCalls = append(p.ResizeCalls, struct{ Rows, Cols int }{rows, cols})
	return nil
}

func (p *MockPTY) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.Closed = true
	return nil
}

func (p *MockPTY) Wait() (int, error) {
	return 0, nil
}
