// Package mock provides a mock implementation of sandbox.Provider for testing.
package mock

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/obot-platform/octobot/server/internal/sandbox"
)

// DefaultMockImage is the default image used by the mock provider.
const DefaultMockImage = "mock:latest"

// Provider is a mock sandbox provider for testing.
type Provider struct {
	mu        sync.RWMutex
	sandboxes map[string]*sandbox.Sandbox
	secrets   map[string]string // sessionID -> raw secret
	image     string            // configured sandbox image

	// Configurable behaviors for testing
	CreateFunc    func(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error)
	StartFunc     func(ctx context.Context, sessionID string) error
	StopFunc      func(ctx context.Context, sessionID string, timeout time.Duration) error
	RemoveFunc    func(ctx context.Context, sessionID string) error
	GetFunc       func(ctx context.Context, sessionID string) (*sandbox.Sandbox, error)
	GetSecretFunc func(ctx context.Context, sessionID string) (string, error)
	ExecFunc      func(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error)
	AttachFunc    func(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error)
}

// NewProvider creates a new mock provider with default behavior.
func NewProvider() *Provider {
	return &Provider{
		sandboxes: make(map[string]*sandbox.Sandbox),
		secrets:   make(map[string]string),
		image:     DefaultMockImage,
	}
}

// NewProviderWithImage creates a new mock provider with a specific image.
func NewProviderWithImage(image string) *Provider {
	return &Provider{
		sandboxes: make(map[string]*sandbox.Sandbox),
		secrets:   make(map[string]string),
		image:     image,
	}
}

// ImageExists always returns true for mock provider (no pulling needed).
func (p *Provider) ImageExists(_ context.Context) bool {
	return true
}

// Image returns the configured sandbox image name.
func (p *Provider) Image() string {
	return p.image
}

// Create creates a mock sandbox.
func (p *Provider) Create(ctx context.Context, sessionID string, opts sandbox.CreateOptions) (*sandbox.Sandbox, error) {
	if p.CreateFunc != nil {
		return p.CreateFunc(ctx, sessionID, opts)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.sandboxes[sessionID]; exists {
		return nil, sandbox.ErrAlreadyExists
	}

	// Store the secret
	if opts.SharedSecret != "" {
		p.secrets[sessionID] = opts.SharedSecret
	}

	// Always simulate port 3002 assignment (deterministic for testing)
	ports := []sandbox.AssignedPort{
		{
			ContainerPort: 3002,
			HostPort:      40888, // Predictable for testing
			HostIP:        "0.0.0.0",
			Protocol:      "tcp",
		},
	}

	s := &sandbox.Sandbox{
		ID:        "mock-" + sessionID,
		SessionID: sessionID,
		Status:    sandbox.StatusCreated,
		Image:     p.image,
		CreatedAt: time.Now(),
		Metadata:  map[string]string{"mock": "true"},
		Ports:     ports,
	}
	p.sandboxes[sessionID] = s
	return s, nil
}

// Start starts a mock sandbox.
func (p *Provider) Start(ctx context.Context, sessionID string) error {
	if p.StartFunc != nil {
		return p.StartFunc(ctx, sessionID)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	s, exists := p.sandboxes[sessionID]
	if !exists {
		return sandbox.ErrNotFound
	}

	if s.Status == sandbox.StatusRunning {
		return sandbox.ErrAlreadyRunning
	}

	s.Status = sandbox.StatusRunning
	now := time.Now()
	s.StartedAt = &now
	return nil
}

// Stop stops a mock sandbox.
func (p *Provider) Stop(ctx context.Context, sessionID string, timeout time.Duration) error {
	if p.StopFunc != nil {
		return p.StopFunc(ctx, sessionID, timeout)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	s, exists := p.sandboxes[sessionID]
	if !exists {
		return sandbox.ErrNotFound
	}

	if s.Status != sandbox.StatusRunning {
		return sandbox.ErrNotRunning
	}

	s.Status = sandbox.StatusStopped
	now := time.Now()
	s.StoppedAt = &now
	return nil
}

// Remove removes a mock sandbox.
func (p *Provider) Remove(ctx context.Context, sessionID string) error {
	if p.RemoveFunc != nil {
		return p.RemoveFunc(ctx, sessionID)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, exists := p.sandboxes[sessionID]; !exists {
		return nil // Idempotent
	}

	delete(p.sandboxes, sessionID)
	delete(p.secrets, sessionID)
	return nil
}

// Get returns a mock sandbox.
func (p *Provider) Get(ctx context.Context, sessionID string) (*sandbox.Sandbox, error) {
	if p.GetFunc != nil {
		return p.GetFunc(ctx, sessionID)
	}

	p.mu.RLock()
	defer p.mu.RUnlock()

	s, exists := p.sandboxes[sessionID]
	if !exists {
		return nil, sandbox.ErrNotFound
	}

	// Return a copy
	cpy := *s
	return &cpy, nil
}

// GetSecret returns the raw shared secret for the sandbox.
func (p *Provider) GetSecret(ctx context.Context, sessionID string) (string, error) {
	if p.GetSecretFunc != nil {
		return p.GetSecretFunc(ctx, sessionID)
	}

	p.mu.RLock()
	defer p.mu.RUnlock()

	if _, exists := p.sandboxes[sessionID]; !exists {
		return "", sandbox.ErrNotFound
	}

	secret, exists := p.secrets[sessionID]
	if !exists || secret == "" {
		return "", fmt.Errorf("shared secret not found for sandbox")
	}

	return secret, nil
}

// Exec runs a mock command.
func (p *Provider) Exec(ctx context.Context, sessionID string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
	if p.ExecFunc != nil {
		return p.ExecFunc(ctx, sessionID, cmd, opts)
	}

	p.mu.RLock()
	_, exists := p.sandboxes[sessionID]
	p.mu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	return &sandbox.ExecResult{
		ExitCode: 0,
		Stdout:   []byte("mock output\n"),
		Stderr:   []byte{},
	}, nil
}

// Attach creates a mock PTY.
func (p *Provider) Attach(ctx context.Context, sessionID string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
	if p.AttachFunc != nil {
		return p.AttachFunc(ctx, sessionID, opts)
	}

	p.mu.RLock()
	s, exists := p.sandboxes[sessionID]
	p.mu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	if s.Status != sandbox.StatusRunning {
		return nil, sandbox.ErrNotRunning
	}

	return &PTY{}, nil
}

// List returns all sandboxes managed by this mock provider.
func (p *Provider) List(_ context.Context) ([]*sandbox.Sandbox, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make([]*sandbox.Sandbox, 0, len(p.sandboxes))
	for _, v := range p.sandboxes {
		cpy := *v
		result = append(result, &cpy)
	}
	return result, nil
}

// HTTPClient returns an HTTP client configured to communicate with the sandbox.
// For mock provider, this creates a client that connects to the mock's mapped TCP port.
func (p *Provider) HTTPClient(_ context.Context, sessionID string) (*http.Client, error) {
	p.mu.RLock()
	s, exists := p.sandboxes[sessionID]
	p.mu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	if s.Status != sandbox.StatusRunning {
		return nil, sandbox.ErrNotRunning
	}

	// Find the HTTP port (3002)
	var httpPort *sandbox.AssignedPort
	for i := range s.Ports {
		if s.Ports[i].ContainerPort == 3002 {
			httpPort = &s.Ports[i]
			break
		}
	}
	if httpPort == nil {
		return nil, fmt.Errorf("sandbox does not expose port 3002")
	}

	hostIP := httpPort.HostIP
	if hostIP == "" || hostIP == "0.0.0.0" {
		hostIP = "127.0.0.1"
	}

	// Create a custom transport that always dials to the sandbox's mapped port
	baseURL := fmt.Sprintf("%s:%d", hostIP, httpPort.HostPort)
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", baseURL)
		},
	}

	return &http.Client{Transport: transport}, nil
}

// GetSandboxes returns all sandboxes (for test assertions).
func (p *Provider) GetSandboxes() map[string]*sandbox.Sandbox {
	p.mu.RLock()
	defer p.mu.RUnlock()

	result := make(map[string]*sandbox.Sandbox)
	for k, v := range p.sandboxes {
		cpy := *v
		result[k] = &cpy
	}
	return result
}

// PTY is a mock PTY for testing.
type PTY struct {
	InputBuffer  []byte
	OutputBuffer []byte
	Closed       bool
	ResizeCalls  []struct{ Rows, Cols int }
	mu           sync.Mutex
}

func (p *PTY) Read(b []byte) (int, error) {
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

func (p *PTY) Write(b []byte) (int, error) {
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

func (p *PTY) Resize(_ context.Context, rows, cols int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.ResizeCalls = append(p.ResizeCalls, struct{ Rows, Cols int }{rows, cols})
	return nil
}

func (p *PTY) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.Closed = true
	return nil
}

func (p *PTY) Wait(_ context.Context) (int, error) {
	return 0, nil
}
