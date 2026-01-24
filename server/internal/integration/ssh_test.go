package integration

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/obot-platform/octobot/server/internal/sandbox"
	"github.com/obot-platform/octobot/server/internal/sandbox/mock"
	"github.com/obot-platform/octobot/server/internal/ssh"
	gossh "golang.org/x/crypto/ssh"
)

func TestSSHServer_Integration_ConnectToSession(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	// Create and start a sandbox
	sessionID := "ssh-test-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{
		SharedSecret: "test-secret",
	})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Create SSH server
	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	// Start server in background
	go sshServer.Start()
	defer sshServer.Stop()

	// Wait for server to start
	time.Sleep(100 * time.Millisecond)

	// Connect as SSH client using session ID as username
	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect to SSH server: %v", err)
	}
	defer client.Close()

	// Verify we can create a session
	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("failed to create SSH session: %v", err)
	}
	defer session.Close()
}

func TestSSHServer_Integration_RejectUnknownSession(t *testing.T) {
	provider := mock.NewProvider()

	// Create SSH server (no sandboxes created)
	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	// Try to connect with unknown session ID
	config := &gossh.ClientConfig{
		User:            "nonexistent-session",
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         2 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err == nil {
		// Connection might succeed at TCP level but server should close it
		// Try to create a session - this should fail
		_, sessErr := client.NewSession()
		client.Close()
		if sessErr == nil {
			t.Error("expected session creation to fail for unknown sandbox")
		}
	}
	// Connection failure is also acceptable
}

func TestSSHServer_Integration_RejectStoppedSandbox(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	// Create sandbox but don't start it (status: created, not running)
	sessionID := "stopped-ssh-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         2 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err == nil {
		_, sessErr := client.NewSession()
		client.Close()
		if sessErr == nil {
			t.Error("expected session creation to fail for stopped sandbox")
		}
	}
}

func TestSSHServer_Integration_MultipleConnections(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	// Create multiple sessions
	sessions := []string{"session-1", "session-2", "session-3"}
	for _, sessionID := range sessions {
		_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
		if err != nil {
			t.Fatalf("failed to create sandbox %s: %v", sessionID, err)
		}
		if err := provider.Start(ctx, sessionID); err != nil {
			t.Fatalf("failed to start sandbox %s: %v", sessionID, err)
		}
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	time.Sleep(100 * time.Millisecond)
	addr := sshServer.Addr() // Capture address before subtests
	defer sshServer.Stop()

	// Connect to each session sequentially (parallel subtests run after parent returns)
	for _, sessionID := range sessions {
		sessionID := sessionID
		t.Run(sessionID, func(t *testing.T) {
			config := &gossh.ClientConfig{
				User:            sessionID,
				HostKeyCallback: gossh.InsecureIgnoreHostKey(),
				Timeout:         5 * time.Second,
			}

			client, err := gossh.Dial("tcp", addr, config)
			if err != nil {
				t.Fatalf("failed to connect to %s: %v", sessionID, err)
			}
			defer client.Close()

			session, err := client.NewSession()
			if err != nil {
				t.Fatalf("failed to create session for %s: %v", sessionID, err)
			}
			session.Close()
		})
	}
}

func TestSSHServer_Integration_HostKeyPersistence(t *testing.T) {
	provider := mock.NewProvider()
	tmpDir := t.TempDir()
	keyPath := tmpDir + "/ssh_host_key"

	// Create first server - generates key
	srv1, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		HostKeyPath:     keyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create first server: %v", err)
	}

	go srv1.Start()
	time.Sleep(100 * time.Millisecond)

	// Get the host key fingerprint
	var firstFingerprint string
	config1 := &gossh.ClientConfig{
		User: "test",
		HostKeyCallback: func(hostname string, remote net.Addr, key gossh.PublicKey) error {
			firstFingerprint = gossh.FingerprintSHA256(key)
			return nil
		},
		Timeout: 2 * time.Second,
	}
	gossh.Dial("tcp", srv1.Addr(), config1) // Will fail auth but we get the key
	srv1.Stop()

	// Create second server - should load same key
	srv2, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		HostKeyPath:     keyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create second server: %v", err)
	}

	go srv2.Start()
	time.Sleep(100 * time.Millisecond)
	defer srv2.Stop()

	var secondFingerprint string
	config2 := &gossh.ClientConfig{
		User: "test",
		HostKeyCallback: func(hostname string, remote net.Addr, key gossh.PublicKey) error {
			secondFingerprint = gossh.FingerprintSHA256(key)
			return nil
		},
		Timeout: 2 * time.Second,
	}
	gossh.Dial("tcp", srv2.Addr(), config2)

	if firstFingerprint != secondFingerprint {
		t.Errorf("host key changed: %s != %s", firstFingerprint, secondFingerprint)
	}
}

// testPTY is a PTY that can be triggered to exit, simulating process death.
type testPTY struct {
	exitCode   int
	exitCh     chan struct{} // Closed when process "exits"
	output     []byte
	outputOnce sync.Once
	mu         sync.Mutex
}

func newTestPTY(exitCode int) *testPTY {
	return &testPTY{
		exitCode: exitCode,
		exitCh:   make(chan struct{}),
		output:   []byte("test output\n"),
	}
}

func (p *testPTY) Read(b []byte) (int, error) {
	p.mu.Lock()
	// First read returns output
	if len(p.output) > 0 {
		n := copy(b, p.output)
		p.output = p.output[n:]
		p.mu.Unlock()
		return n, nil
	}
	p.mu.Unlock()

	// Block until process "exits", then return EOF
	<-p.exitCh
	return 0, io.EOF
}

func (p *testPTY) Write(b []byte) (int, error) {
	select {
	case <-p.exitCh:
		return 0, io.ErrClosedPipe
	default:
		return len(b), nil
	}
}

func (p *testPTY) Resize(_ context.Context, rows, cols int) error {
	return nil
}

func (p *testPTY) Close() error {
	p.outputOnce.Do(func() {
		close(p.exitCh)
	})
	return nil
}

func (p *testPTY) Wait(_ context.Context) (int, error) {
	<-p.exitCh
	return p.exitCode, nil
}

// Exit triggers the process to exit with the configured exit code.
func (p *testPTY) Exit() {
	p.outputOnce.Do(func() {
		close(p.exitCh)
	})
}

func TestSSHServer_Integration_SessionTerminatesOnProcessExit(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	sessionID := "exit-test-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Create a PTY that we can trigger to exit
	pty := newTestPTY(42) // Exit code 42

	// Hook AttachFunc to return our test PTY
	provider.AttachFunc = func(_ context.Context, sid string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		if sid != sessionID {
			return nil, sandbox.ErrNotFound
		}
		return pty, nil
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	// Request PTY and shell
	if err := session.RequestPty("xterm", 24, 80, gossh.TerminalModes{}); err != nil {
		t.Fatalf("failed to request pty: %v", err)
	}

	// Start shell in background
	shellDone := make(chan error, 1)
	go func() {
		shellDone <- session.Shell()
	}()

	// Wait a bit for shell to start
	time.Sleep(50 * time.Millisecond)

	// Trigger process exit
	pty.Exit()

	// Session should terminate within a reasonable time
	select {
	case <-shellDone:
		// Shell returned - good
	case <-time.After(2 * time.Second):
		t.Fatal("session did not terminate after process exit")
	}

	// Wait for session to fully close and get exit status
	err = session.Wait()
	if err == nil {
		t.Error("expected non-nil error from Wait() for non-zero exit code")
	}

	// Check if we got the right exit code (42)
	if exitErr, ok := err.(*gossh.ExitError); ok {
		if exitErr.ExitStatus() != 42 {
			t.Errorf("exit code = %d, want 42", exitErr.ExitStatus())
		}
	} else {
		// Some SSH implementations may not return ExitError
		t.Logf("got error type %T: %v (exit code verification skipped)", err, err)
	}
}

func TestSSHServer_Integration_SessionTerminatesOnExecExit(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	sessionID := "exec-exit-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Hook ExecFunc to simulate command execution
	provider.ExecFunc = func(_ context.Context, sid string, cmd []string, opts sandbox.ExecOptions) (*sandbox.ExecResult, error) {
		if sid != sessionID {
			return nil, sandbox.ErrNotFound
		}
		// Simulate running "exit 5"
		return &sandbox.ExecResult{
			ExitCode: 5,
			Stdout:   []byte("command output\n"),
			Stderr:   []byte{},
		}, nil
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer session.Close()

	// Run a command that exits
	output, err := session.CombinedOutput("exit 5")
	if err == nil {
		t.Error("expected error from command with non-zero exit code")
	}

	// Verify output was received
	if string(output) != "command output\n" {
		t.Errorf("output = %q, want %q", string(output), "command output\n")
	}

	// Check exit code
	if exitErr, ok := err.(*gossh.ExitError); ok {
		if exitErr.ExitStatus() != 5 {
			t.Errorf("exit code = %d, want 5", exitErr.ExitStatus())
		}
	}
}

// testStream is a mock stream that simulates socat for port forwarding tests.
type testStream struct {
	// Input received from SSH channel (to be forwarded to "remote")
	inputBuf []byte
	// Output to send back to SSH channel (from "remote")
	outputBuf []byte
	exitCode  int
	closed    bool
	exitCh    chan struct{}
	mu        sync.Mutex
}

func newTestStream(response []byte, exitCode int) *testStream {
	return &testStream{
		outputBuf: response,
		exitCode:  exitCode,
		exitCh:    make(chan struct{}),
	}
}

func (s *testStream) Read(b []byte) (int, error) {
	s.mu.Lock()
	if len(s.outputBuf) > 0 {
		n := copy(b, s.outputBuf)
		s.outputBuf = s.outputBuf[n:]
		s.mu.Unlock()
		return n, nil
	}
	s.mu.Unlock()

	// Block until closed
	<-s.exitCh
	return 0, io.EOF
}

func (s *testStream) Write(b []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, io.ErrClosedPipe
	}
	s.inputBuf = append(s.inputBuf, b...)
	return len(b), nil
}

func (s *testStream) CloseWrite() error {
	return nil
}

func (s *testStream) Close() error {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.exitCh)
	}
	s.mu.Unlock()
	return nil
}

func (s *testStream) Wait(_ context.Context) (int, error) {
	<-s.exitCh
	return s.exitCode, nil
}

func (s *testStream) GetInput() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.inputBuf...)
}

func TestSSHServer_Integration_PortForwarding(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	sessionID := "portfwd-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Create a test stream that simulates socat
	// When data is written, it echoes it back (simulating a simple TCP echo server)
	var testStreamInstance *testStream

	// Hook ExecStreamFunc to intercept socat calls
	provider.ExecStreamFunc = func(_ context.Context, sid string, cmd []string, _ sandbox.ExecStreamOptions) (sandbox.Stream, error) {
		if sid != sessionID {
			return nil, sandbox.ErrNotFound
		}
		// Verify the command looks like a socat call
		if len(cmd) < 2 || cmd[0] != "socat" {
			return nil, fmt.Errorf("unexpected command: %v", cmd)
		}
		// Return a stream that echoes "PONG" response
		testStreamInstance = newTestStream([]byte("PONG"), 0)
		return testStreamInstance, nil
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Close()

	// Open a direct-tcpip channel (port forwarding)
	// This simulates ssh -L connecting to localhost:8080 inside the container
	channel, reqs, err := client.OpenChannel("direct-tcpip", marshalDirectTCPIP("localhost", 8080, "127.0.0.1", 12345))
	if err != nil {
		t.Fatalf("failed to open direct-tcpip channel: %v", err)
	}
	go gossh.DiscardRequests(reqs)
	defer channel.Close()

	// Write data through the tunnel
	_, err = channel.Write([]byte("PING"))
	if err != nil {
		t.Fatalf("failed to write to tunnel: %v", err)
	}

	// Read response
	buf := make([]byte, 100)
	n, err := channel.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatalf("failed to read from tunnel: %v", err)
	}

	response := string(buf[:n])
	if response != "PONG" {
		t.Errorf("response = %q, want %q", response, "PONG")
	}

	// Close the channel and wait for stream to clean up
	channel.Close()
	time.Sleep(50 * time.Millisecond)

	// Verify the input was received
	if testStreamInstance != nil {
		input := testStreamInstance.GetInput()
		if string(input) != "PING" {
			t.Errorf("forwarded input = %q, want %q", string(input), "PING")
		}
	}
}

func TestSSHServer_Integration_SFTP(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	sessionID := "sftp-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Track if ExecStream was called with sftp-server
	var sftpCalled bool
	var sftpCommand []string

	// Hook ExecStreamFunc to intercept sftp-server calls
	provider.ExecStreamFunc = func(_ context.Context, sid string, cmd []string, _ sandbox.ExecStreamOptions) (sandbox.Stream, error) {
		if sid != sessionID {
			return nil, sandbox.ErrNotFound
		}
		sftpCalled = true
		sftpCommand = cmd
		// Return a stream that simulates sftp-server
		// In reality, sftp-server speaks a binary protocol, but for testing
		// we just need to verify the command is called correctly
		return newTestStream([]byte{}, 0), nil
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}
	defer session.Close()

	// Request SFTP subsystem
	err = session.RequestSubsystem("sftp")
	if err != nil {
		t.Fatalf("failed to request sftp subsystem: %v", err)
	}

	// Verify sftp-server was called
	if !sftpCalled {
		t.Error("ExecStream was not called for SFTP")
	}

	// Verify the correct command was used
	expectedCmd := "/usr/lib/openssh/sftp-server"
	if len(sftpCommand) == 0 || sftpCommand[0] != expectedCmd {
		t.Errorf("sftp command = %v, want [%s]", sftpCommand, expectedCmd)
	}
}

func TestSSHServer_Integration_UserInfoFetcher(t *testing.T) {
	provider := mock.NewProvider()
	ctx := context.Background()

	sessionID := "user-test-session"
	_, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create sandbox: %v", err)
	}
	if err := provider.Start(ctx, sessionID); err != nil {
		t.Fatalf("failed to start sandbox: %v", err)
	}

	// Track the user passed to Attach
	var attachedUser string

	provider.AttachFunc = func(_ context.Context, sid string, opts sandbox.AttachOptions) (sandbox.PTY, error) {
		if sid != sessionID {
			return nil, sandbox.ErrNotFound
		}
		attachedUser = opts.User
		pty := newTestPTY(0)
		// Exit immediately
		go func() {
			time.Sleep(10 * time.Millisecond)
			pty.Exit()
		}()
		return pty, nil
	}

	// Create a mock UserInfoFetcher
	userFetcher := &mockUserInfoFetcher{
		uid: 1000,
		gid: 1000,
	}

	sshServer, err := ssh.New(&ssh.Config{
		Address:         "127.0.0.1:0",
		SandboxProvider: provider,
		UserInfoFetcher: userFetcher,
	})
	if err != nil {
		t.Fatalf("failed to create SSH server: %v", err)
	}

	go sshServer.Start()
	defer sshServer.Stop()
	time.Sleep(100 * time.Millisecond)

	config := &gossh.ClientConfig{
		User:            sessionID,
		HostKeyCallback: gossh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	}

	client, err := gossh.Dial("tcp", sshServer.Addr(), config)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer client.Close()

	session, err := client.NewSession()
	if err != nil {
		t.Fatalf("failed to create session: %v", err)
	}

	// Request PTY and shell
	if err := session.RequestPty("xterm", 24, 80, gossh.TerminalModes{}); err != nil {
		t.Fatalf("failed to request pty: %v", err)
	}

	if err := session.Shell(); err != nil {
		t.Fatalf("failed to start shell: %v", err)
	}

	// Wait for shell to complete
	session.Wait()
	session.Close()

	// Verify the user was passed correctly (uid:gid format)
	expectedUser := "1000:1000"
	if attachedUser != expectedUser {
		t.Errorf("attached user = %q, want %q", attachedUser, expectedUser)
	}
}

// mockUserInfoFetcher implements ssh.UserInfoFetcher for testing.
type mockUserInfoFetcher struct {
	uid int
	gid int
}

func (m *mockUserInfoFetcher) GetUserInfo(_ context.Context, _ string) (string, int, int, error) {
	return "testuser", m.uid, m.gid, nil
}

// marshalDirectTCPIP creates the payload for a direct-tcpip channel request.
func marshalDirectTCPIP(destHost string, destPort uint32, origHost string, origPort uint32) []byte {
	payload := make([]byte, 0)

	// Dest host (length-prefixed string)
	payload = append(payload, byte(len(destHost)>>24), byte(len(destHost)>>16), byte(len(destHost)>>8), byte(len(destHost)))
	payload = append(payload, []byte(destHost)...)

	// Dest port
	payload = append(payload, byte(destPort>>24), byte(destPort>>16), byte(destPort>>8), byte(destPort))

	// Orig host
	payload = append(payload, byte(len(origHost)>>24), byte(len(origHost)>>16), byte(len(origHost)>>8), byte(len(origHost)))
	payload = append(payload, []byte(origHost)...)

	// Orig port
	payload = append(payload, byte(origPort>>24), byte(origPort>>16), byte(origPort>>8), byte(origPort))

	return payload
}
