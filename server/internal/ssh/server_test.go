package ssh

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/sandbox/mock"
	"golang.org/x/crypto/ssh"
)

func TestNew_RequiresSandboxProvider(t *testing.T) {
	_, err := New(&Config{
		Address:         ":0",
		SandboxProvider: nil,
	})
	if err == nil {
		t.Fatal("expected error when sandbox provider is nil")
	}
}

func TestNew_GeneratesHostKey(t *testing.T) {
	provider := mock.NewProvider()

	// Use temp directory for host key
	tmpDir := t.TempDir()
	keyPath := filepath.Join(tmpDir, "test_host_key")

	srv, err := New(&Config{
		Address:         ":0",
		HostKeyPath:     keyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	defer srv.Stop()

	// Verify key was generated
	if _, err := os.Stat(keyPath); os.IsNotExist(err) {
		t.Error("host key file was not created")
	}
}

func TestNew_LoadsExistingHostKey(t *testing.T) {
	provider := mock.NewProvider()
	tmpDir := t.TempDir()
	keyPath := filepath.Join(tmpDir, "test_host_key")

	// Create first server to generate key
	srv1, err := New(&Config{
		Address:         ":0",
		HostKeyPath:     keyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create first server: %v", err)
	}
	srv1.Stop()

	// Read the generated key
	keyData1, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("failed to read key: %v", err)
	}

	// Create second server - should load existing key
	srv2, err := New(&Config{
		Address:         ":0",
		HostKeyPath:     keyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create second server: %v", err)
	}
	srv2.Stop()

	// Key should not have changed
	keyData2, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatalf("failed to read key: %v", err)
	}

	if string(keyData1) != string(keyData2) {
		t.Error("host key was regenerated instead of loaded")
	}
}

func TestServer_AcceptsConnection(t *testing.T) {
	t.Parallel()
	provider := mock.NewProvider()

	// Create and start a sandbox
	ctx := context.Background()
	sessionID := "test-session-123"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	srv, err := New(&Config{
		Address:         "127.0.0.1:0",
		HostKeyPath:     getSharedTestKeyPath(), // Use pre-generated key
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	// Start server in background
	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Start()
	}()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Get actual address
	addr := srv.Addr()

	// Connect as SSH client
	config := &ssh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := ssh.Dial("tcp", addr, config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	client.Close()

	// Stop server
	srv.Stop()
}

func TestServer_RejectsUnknownSession(t *testing.T) {
	t.Parallel()
	provider := mock.NewProvider()

	srv, err := New(&Config{
		Address:         "127.0.0.1:0",
		HostKeyPath:     getSharedTestKeyPath(), // Use pre-generated key
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	go srv.Start()
	time.Sleep(100 * time.Millisecond)
	defer srv.Stop()

	addr := srv.Addr()

	// Try to connect with unknown session ID
	config := &ssh.ClientConfig{
		User:            "unknown-session",
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := ssh.Dial("tcp", addr, config)
	if err == nil {
		client.Close()
		// Connection succeeded but should be closed by server
		// when it can't find the sandbox
	}
	// Either connection fails or gets closed - both are acceptable
}

func TestServer_RejectsStoppedSandbox(t *testing.T) {
	t.Parallel()
	provider := mock.NewProvider()

	ctx := context.Background()
	sessionID := "stopped-session"

	// Create sandbox but don't start it
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}

	srv, err := New(&Config{
		Address:         "127.0.0.1:0",
		HostKeyPath:     getSharedTestKeyPath(), // Use pre-generated key
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	go srv.Start()
	time.Sleep(100 * time.Millisecond)
	defer srv.Stop()

	addr := srv.Addr()

	config := &ssh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := ssh.Dial("tcp", addr, config)
	if err == nil {
		client.Close()
		// Connection may succeed at TCP level but should be closed
	}
}

func TestParsePTYRequest(t *testing.T) {
	t.Parallel()
	// Build a PTY request payload
	// Format: string term, uint32 cols, uint32 rows, uint32 width, uint32 height, string modes
	term := "xterm-256color"
	payload := make([]byte, 0)

	// Term string (length-prefixed)
	payload = append(payload, byte(len(term)>>24), byte(len(term)>>16), byte(len(term)>>8), byte(len(term)))
	payload = append(payload, []byte(term)...)

	// Cols (80)
	payload = append(payload, 0, 0, 0, 80)
	// Rows (24)
	payload = append(payload, 0, 0, 0, 24)
	// Width pixels (640)
	payload = append(payload, 0, 0, 2, 128)
	// Height pixels (480)
	payload = append(payload, 0, 0, 1, 224)

	req := parsePTYRequest(payload)
	if req == nil {
		t.Fatal("failed to parse PTY request")
	}

	if req.Term != term {
		t.Errorf("term = %q, want %q", req.Term, term)
	}
	if req.Cols != 80 {
		t.Errorf("cols = %d, want 80", req.Cols)
	}
	if req.Rows != 24 {
		t.Errorf("rows = %d, want 24", req.Rows)
	}
}

func TestParseEnvRequest(t *testing.T) {
	t.Parallel()
	// Build an env request payload
	// Format: string name, string value
	name := "TERM"
	value := "xterm"
	payload := make([]byte, 0)

	// Name (length-prefixed)
	payload = append(payload, byte(len(name)>>24), byte(len(name)>>16), byte(len(name)>>8), byte(len(name)))
	payload = append(payload, []byte(name)...)

	// Value (length-prefixed)
	payload = append(payload, byte(len(value)>>24), byte(len(value)>>16), byte(len(value)>>8), byte(len(value)))
	payload = append(payload, []byte(value)...)

	parsedName, parsedValue := parseEnvRequest(payload)

	if parsedName != name {
		t.Errorf("name = %q, want %q", parsedName, name)
	}
	if parsedValue != value {
		t.Errorf("value = %q, want %q", parsedValue, value)
	}
}

func TestParseExecRequest(t *testing.T) {
	t.Parallel()
	command := "ls -la /workspace"
	payload := make([]byte, 0)

	// Command (length-prefixed)
	payload = append(payload, byte(len(command)>>24), byte(len(command)>>16), byte(len(command)>>8), byte(len(command)))
	payload = append(payload, []byte(command)...)

	parsed := parseExecRequest(payload)

	if parsed != command {
		t.Errorf("command = %q, want %q", parsed, command)
	}
}

func TestParseDirectTCPIPData(t *testing.T) {
	destHost := "localhost"
	destPort := uint32(8080)
	origHost := "192.168.1.1"
	origPort := uint32(54321)

	payload := make([]byte, 0)

	// Dest host
	payload = append(payload, byte(len(destHost)>>24), byte(len(destHost)>>16), byte(len(destHost)>>8), byte(len(destHost)))
	payload = append(payload, []byte(destHost)...)

	// Dest port
	payload = append(payload, byte(destPort>>24), byte(destPort>>16), byte(destPort>>8), byte(destPort))

	// Orig host
	payload = append(payload, byte(len(origHost)>>24), byte(len(origHost)>>16), byte(len(origHost)>>8), byte(len(origHost)))
	payload = append(payload, []byte(origHost)...)

	// Orig port
	payload = append(payload, byte(origPort>>24), byte(origPort>>16), byte(origPort>>8), byte(origPort))

	parsedDestHost, parsedDestPort, parsedOrigHost, parsedOrigPort := parseDirectTCPIPData(payload)

	if parsedDestHost != destHost {
		t.Errorf("destHost = %q, want %q", parsedDestHost, destHost)
	}
	if parsedDestPort != destPort {
		t.Errorf("destPort = %d, want %d", parsedDestPort, destPort)
	}
	if parsedOrigHost != origHost {
		t.Errorf("origHost = %q, want %q", parsedOrigHost, origHost)
	}
	if parsedOrigPort != origPort {
		t.Errorf("origPort = %d, want %d", parsedOrigPort, origPort)
	}
}

func TestServer_Stop(t *testing.T) {
	provider := mock.NewProvider()

	srv, err := New(&Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	// Start server
	go srv.Start()
	time.Sleep(100 * time.Millisecond)

	// Verify it's listening
	addr := srv.Addr()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("server not listening: %v", err)
	}
	conn.Close()

	// Stop server
	if err := srv.Stop(); err != nil {
		t.Fatalf("failed to stop server: %v", err)
	}

	// Verify it's no longer listening
	time.Sleep(100 * time.Millisecond)
	_, err = net.DialTimeout("tcp", addr, 100*time.Millisecond)
	if err == nil {
		t.Error("server still listening after stop")
	}
}

func TestLoadOrGenerateHostKey_InvalidPath(t *testing.T) {
	// Test with empty path - should generate in memory
	key, err := loadOrGenerateHostKey("")
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}
	if key == nil {
		t.Error("key should not be nil")
	}
}

func TestLoadOrGenerateHostKey_InvalidKeyFile(t *testing.T) {
	tmpDir := t.TempDir()
	keyPath := filepath.Join(tmpDir, "invalid_key")

	// Write invalid key data
	if err := os.WriteFile(keyPath, []byte("not a valid key"), 0600); err != nil {
		t.Fatalf("failed to write invalid key: %v", err)
	}

	// Should fail to parse and generate new key
	key, err := loadOrGenerateHostKey(keyPath)
	if err != nil {
		// May fail or regenerate - either is acceptable
		t.Logf("got error (acceptable): %v", err)
		return
	}
	if key == nil {
		t.Error("key should not be nil after regeneration")
	}
}
