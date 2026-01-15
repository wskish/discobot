//go:build darwin

package vz

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/Code-Hex/vz/v3"

	"github.com/anthropics/octobot/server/internal/sandbox"
)

// VsockPort is the default vsock port for HTTP communication with the guest agent.
const VsockPort = 3002

// Dial creates a vsock connection to the guest VM.
// The returned connection implements net.Conn and can be used with http.Transport.
func (p *Provider) Dial(ctx context.Context, sessionID string, port uint32) (net.Conn, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	if instance.status != sandbox.StatusRunning {
		instance.mu.RUnlock()
		return nil, sandbox.ErrNotRunning
	}
	socketDevice := instance.socketDevice
	instance.mu.RUnlock()

	if socketDevice == nil {
		return nil, fmt.Errorf("vsock not available for session %s", sessionID)
	}

	conn, err := socketDevice.Connect(port)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to vsock port %d: %w", port, err)
	}

	return &vsockConn{
		VirtioSocketConnection: conn,
		localAddr:              &vsockAddr{cid: 2, port: 0},         // Host CID is always 2
		remoteAddr:             &vsockAddr{cid: 3, port: port},      // Guest CID (typically 3)
	}, nil
}

// DialContext returns a dial function suitable for use with http.Transport.
// Usage:
//
//	transport := &http.Transport{
//	    DialContext: provider.DialContext(sessionID, VsockPort),
//	}
//	client := &http.Client{Transport: transport}
func (p *Provider) DialContext(sessionID string, port uint32) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		return p.Dial(ctx, sessionID, port)
	}
}

// httpClientForPort returns an http.Client configured to communicate with the guest VM over vsock.
// The client connects to the specified vsock port (typically VsockPort/3002).
func (p *Provider) httpClientForPort(sessionID string, port uint32) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext:     p.DialContext(sessionID, port),
			MaxIdleConns:    10,
			IdleConnTimeout: 30 * time.Second,
		},
	}
}

// vsockConn wraps vz.VirtioSocketConnection to implement net.Conn.
type vsockConn struct {
	*vz.VirtioSocketConnection
	localAddr  net.Addr
	remoteAddr net.Addr
	closeOnce  sync.Once
	closed     bool
	mu         sync.Mutex
}

// LocalAddr returns the local network address.
func (c *vsockConn) LocalAddr() net.Addr {
	return c.localAddr
}

// RemoteAddr returns the remote network address.
func (c *vsockConn) RemoteAddr() net.Addr {
	return c.remoteAddr
}

// SetDeadline sets the read and write deadlines.
// Note: vz.VirtioSocketConnection doesn't support deadlines, so this is a no-op.
func (c *vsockConn) SetDeadline(t time.Time) error {
	// VirtioSocketConnection doesn't support deadlines
	// Return nil to satisfy the interface - callers should use context cancellation
	return nil
}

// SetReadDeadline sets the read deadline.
// Note: vz.VirtioSocketConnection doesn't support deadlines, so this is a no-op.
func (c *vsockConn) SetReadDeadline(t time.Time) error {
	return nil
}

// SetWriteDeadline sets the write deadline.
// Note: vz.VirtioSocketConnection doesn't support deadlines, so this is a no-op.
func (c *vsockConn) SetWriteDeadline(t time.Time) error {
	return nil
}

// Close closes the connection.
func (c *vsockConn) Close() error {
	var err error
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		err = c.VirtioSocketConnection.Close()
	})
	return err
}

// vsockAddr implements net.Addr for vsock addresses.
type vsockAddr struct {
	cid  uint32
	port uint32
}

// Network returns the network type.
func (a *vsockAddr) Network() string {
	return "vsock"
}

// String returns the string representation of the address.
func (a *vsockAddr) String() string {
	return fmt.Sprintf("vsock://%d:%d", a.cid, a.port)
}

// GetHTTPClient is a convenience method on Provider to get an HTTP client for a session.
// This is the primary way to communicate with the guest agent.
//
// Example usage:
//
//	client, err := provider.GetHTTPClient(ctx, sessionID)
//	if err != nil {
//	    return err
//	}
//	resp, err := client.Get("http://localhost/api/health")
//
// Note: The URL host doesn't matter since we're using vsock - use "localhost" by convention.
func (p *Provider) HTTPClient(ctx context.Context, sessionID string) (*http.Client, error) {
	p.vmInstancesMu.RLock()
	instance, exists := p.vmInstances[sessionID]
	p.vmInstancesMu.RUnlock()

	if !exists {
		return nil, sandbox.ErrNotFound
	}

	instance.mu.RLock()
	defer instance.mu.RUnlock()

	if instance.status != sandbox.StatusRunning {
		return nil, sandbox.ErrNotRunning
	}

	if instance.socketDevice == nil {
		return nil, fmt.Errorf("vsock not available for session %s", sessionID)
	}

	return p.httpClientForPort(sessionID, VsockPort), nil
}
