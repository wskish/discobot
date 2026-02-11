//go:build darwin

package vz

import (
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/Code-Hex/vz/v3"
)

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
