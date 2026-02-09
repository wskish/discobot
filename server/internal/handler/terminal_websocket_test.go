package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/gorilla/websocket"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/obot-platform/discobot/server/internal/model"
	"github.com/obot-platform/discobot/server/internal/sandbox"
	"github.com/obot-platform/discobot/server/internal/sandbox/mock"
	"github.com/obot-platform/discobot/server/internal/service"
	"github.com/obot-platform/discobot/server/internal/store"
)

// mockPTY implements sandbox.PTY for testing terminal behavior
type mockPTY struct {
	readBuffer  *bytes.Buffer
	writeBuffer *bytes.Buffer
	readErr     error
	writeErr    error
	resizeErr   error
	exitCode    int
	waitDelay   time.Duration
	closed      bool
	mu          sync.Mutex
	readDelay   time.Duration // Simulate slow reads
	onRead      func()        // Callback for read operations
	onWrite     func()        // Callback for write operations
}

func newMockPTY() *mockPTY {
	return &mockPTY{
		readBuffer:  bytes.NewBuffer(nil),
		writeBuffer: bytes.NewBuffer(nil),
		exitCode:    0,
	}
}

func (m *mockPTY) Read(p []byte) (n int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.onRead != nil {
		m.onRead()
	}

	if m.readDelay > 0 {
		time.Sleep(m.readDelay)
	}

	if m.readErr != nil {
		return 0, m.readErr
	}

	return m.readBuffer.Read(p)
}

func (m *mockPTY) Write(p []byte) (n int, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.onWrite != nil {
		m.onWrite()
	}

	if m.writeErr != nil {
		return 0, m.writeErr
	}

	return m.writeBuffer.Write(p)
}

func (m *mockPTY) Resize(_ context.Context, _, _ int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.resizeErr
}

func (m *mockPTY) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	return nil
}

func (m *mockPTY) Wait(_ context.Context) (int, error) {
	if m.waitDelay > 0 {
		time.Sleep(m.waitDelay)
	}
	return m.exitCode, nil
}

// feedOutput simulates PTY producing output
func (m *mockPTY) feedOutput(data string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.readBuffer.WriteString(data)
}

// setReadError makes the next Read call return an error
func (m *mockPTY) setReadError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.readErr = err
}

// setWriteError makes Write calls return an error
func (m *mockPTY) setWriteError(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.writeErr = err
}

// getWrittenData returns what was written to the PTY
func (m *mockPTY) getWrittenData() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.writeBuffer.String()
}

// TestHandleTerminalSession_NormalFlow tests the happy path where everything works
func TestHandleTerminalSession_NormalFlow(t *testing.T) {
	// Setup mock PTY
	pty := newMockPTY()
	pty.feedOutput("hello from shell\n")
	pty.feedOutput("$ ")
	pty.exitCode = 0
	pty.waitDelay = 50 * time.Millisecond

	// Create mock WebSocket connection (server and client)
	server, client := createMockWebSocketPair(t)
	defer server.Close()
	defer client.Close()

	// Run handler in goroutine
	ctx := context.Background()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer pty.Close() // PTY cleanup is caller's responsibility
		handleTerminalSession(ctx, pty, server)
	}()

	// Read initial output
	var msg TerminalMessage
	if err := client.ReadJSON(&msg); err != nil {
		t.Fatalf("Failed to read message: %v", err)
	}

	if msg.Type != "output" {
		t.Errorf("Expected output message, got %s", msg.Type)
	}

	var output string
	if err := json.Unmarshal(msg.Data, &output); err != nil {
		t.Fatalf("Failed to unmarshal output: %v", err)
	}

	if !strings.Contains(output, "hello from shell") {
		t.Errorf("Expected output to contain 'hello from shell', got: %q", output)
	}

	// Send input
	inputMsg := TerminalMessage{
		Type: "input",
		Data: json.RawMessage(`"ls\n"`),
	}
	if err := client.WriteJSON(inputMsg); err != nil {
		t.Fatalf("Failed to send input: %v", err)
	}

	// Wait for handler to finish
	select {
	case <-done:
		// Success
	case <-time.After(2 * time.Second):
		t.Fatal("Handler didn't finish in time")
	}

	// Verify input was written to PTY
	written := pty.getWrittenData()
	if written != "ls\n" {
		t.Errorf("Expected PTY to receive 'ls\\n', got: %q", written)
	}

	// PTY should be closed after handler exits
	if !pty.closed {
		t.Error("PTY should be closed after shell exits")
	}
}

// TestHandleTerminalSession_HalfClose_ClientStopsWriting tests that output continues
// when the client stops writing but the PTY is still producing output
func TestHandleTerminalSession_HalfClose_ClientStopsWriting(t *testing.T) {
	t.Skip("TODO: Fix WebSocket lifecycle handling in test")
	// This is the key test for half-close support!
	pty := newMockPTY()
	pty.waitDelay = 200 * time.Millisecond // PTY takes time to exit

	// Set up a callback to feed output when reads happen
	readCount := 0
	pty.onRead = func() {
		readCount++
		// Feed some output, then EOF
		switch readCount {
		case 1:
			pty.readBuffer.WriteString("output line 1\n")
		case 2:
			pty.readBuffer.WriteString("output line 2\n")
		case 3:
			pty.readBuffer.WriteString("output line 3\n")
		default:
			pty.setReadError(io.EOF)
		}
	}

	// Create WebSocket pair
	server, client := createMockWebSocketPair(t)
	defer server.Close()
	defer client.Close()

	// Run handler in goroutine
	ctx := context.Background()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer pty.Close()
		handleTerminalSession(ctx, pty, server)
	}()

	// Collect output from client
	outputReceived := make(chan string, 10)
	go func() {
		for {
			var msg TerminalMessage
			if err := client.ReadJSON(&msg); err != nil {
				return
			}
			if msg.Type == "output" {
				var output string
				json.Unmarshal(msg.Data, &output)
				outputReceived <- output
			}
		}
	}()

	// Simulate client "closing its write side" by just not sending any more messages
	// The output goroutine should continue reading from PTY and sending to client

	// Collect all output
	// Note: Client doesn't send ANY input, but should still receive all output
	timeout := time.After(2 * time.Second)
	allOutput := []string{}

collectLoop:
	for {
		select {
		case output := <-outputReceived:
			allOutput = append(allOutput, output)
			if len(allOutput) >= 3 {
				break collectLoop
			}
		case <-timeout:
			t.Fatal("Timeout waiting for output")
		}
	}

	// Now close client to signal end of test and let handler exit
	// Send close frame first
	closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "test done")
	client.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
	client.Close()

	// Wait for handler to finish
	select {
	case <-done:
		// Success
	case <-time.After(2 * time.Second):
		t.Fatal("Handler didn't finish after client closed")
	}

	// Verify we got all the output even though client didn't send any input
	if len(allOutput) < 3 {
		t.Errorf("Expected at least 3 output messages, got %d", len(allOutput))
	}

	fullOutput := strings.Join(allOutput, "")
	if !strings.Contains(fullOutput, "output line 1") {
		t.Error("Missing 'output line 1'")
	}
	if !strings.Contains(fullOutput, "output line 2") {
		t.Error("Missing 'output line 2'")
	}
	if !strings.Contains(fullOutput, "output line 3") {
		t.Error("Missing 'output line 3'")
	}

	// PTY should be properly closed
	if !pty.closed {
		t.Error("PTY should be closed")
	}
}

// TestTerminalWebSocket_PTYExitsCleanly tests Ctrl-D scenario
func TestTerminalWebSocket_PTYExitsCleanly(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()
	pty.feedOutput("$ exit\n")
	pty.exitCode = 0

	// After output is read, return EOF
	readOnce := false
	pty.onRead = func() {
		if readOnce {
			pty.setReadError(io.EOF)
		}
		readOnce = true
	}

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Read output
	var msg TerminalMessage
	if err := ws.ReadJSON(&msg); err != nil {
		t.Fatalf("Failed to read: %v", err)
	}

	// Wait for close message
	_, _, err = ws.ReadMessage()
	if err == nil {
		t.Error("Expected connection to close")
	}

	if !websocket.IsCloseError(err, websocket.CloseNormalClosure) {
		t.Errorf("Expected CloseNormalClosure, got: %v", err)
	}

	// Verify PTY was closed
	time.Sleep(50 * time.Millisecond)
	if !pty.closed {
		t.Error("PTY should be closed")
	}
}

// TestTerminalWebSocket_PTYWriteError tests when writing to PTY fails
func TestTerminalWebSocket_PTYWriteError(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()
	pty.setWriteError(errors.New("pty write failed"))
	pty.feedOutput("initial output\n")

	readOnce := false
	pty.onRead = func() {
		if !readOnce {
			readOnce = true
			return
		}
		pty.setReadError(io.EOF)
	}

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Read initial output
	var msg TerminalMessage
	ws.ReadJSON(&msg)

	// Try to send input (should fail to write to PTY)
	inputMsg := TerminalMessage{
		Type: "input",
		Data: json.RawMessage(`"test input\n"`),
	}
	ws.WriteJSON(inputMsg)

	// Output should still continue
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if err := ws.ReadJSON(&msg); err != nil {
			break
		}
	}

	// Verify PTY was eventually closed
	time.Sleep(100 * time.Millisecond)
	if !pty.closed {
		t.Error("PTY should be closed")
	}
}

// TestTerminalWebSocket_PTYReadError tests non-EOF read errors
func TestTerminalWebSocket_PTYReadError(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()
	pty.feedOutput("some output\n")

	readOnce := false
	pty.onRead = func() {
		if !readOnce {
			readOnce = true
			return
		}
		// Simulate a non-EOF error
		pty.setReadError(errors.New("pty read failed"))
	}

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Read initial output
	var msg TerminalMessage
	ws.ReadJSON(&msg)

	// Connection should close due to error
	ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		if err := ws.ReadJSON(&msg); err != nil {
			break
		}
	}

	// Verify cleanup happened
	time.Sleep(100 * time.Millisecond)
	if !pty.closed {
		t.Error("PTY should be closed after read error")
	}
}

// TestTerminalWebSocket_ResizeOperations tests terminal resize handling
func TestTerminalWebSocket_ResizeOperations(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()
	pty.feedOutput("$ ")

	resizeReceived := make(chan bool, 1)
	pty.onRead = func() {
		// After first read, return EOF
		pty.setReadError(io.EOF)
	}

	// Track resize calls - we'll override the resize method
	pty.resizeErr = nil
	oldOnRead := pty.onRead
	pty.onRead = func() {
		// Track that resize was called (implicitly through the handler)
		// We can't easily override the method, so we'll just check that
		// the resize message doesn't cause an error
		if oldOnRead != nil {
			oldOnRead()
		}
	}

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Read initial output
	var msg TerminalMessage
	ws.ReadJSON(&msg)

	// Send resize message
	resizeData, _ := json.Marshal(ResizeData{Rows: 40, Cols: 120})
	resizeMsg := TerminalMessage{
		Type: "resize",
		Data: json.RawMessage(resizeData),
	}
	if err := ws.WriteJSON(resizeMsg); err != nil {
		t.Fatalf("Failed to send resize: %v", err)
	}

	// Wait for resize to be processed
	select {
	case <-resizeReceived:
		// Success!
	case <-time.After(2 * time.Second):
		t.Error("Resize was not processed")
	}

	ws.Close()
}

// TestTerminalWebSocket_OutputDraining tests that all output is sent before closing
func TestTerminalWebSocket_OutputDraining(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()

	// Feed multiple chunks of output
	outputChunks := []string{
		"chunk 1\n",
		"chunk 2\n",
		"chunk 3\n",
		"chunk 4\n",
		"chunk 5\n",
	}

	chunkIndex := 0
	pty.onRead = func() {
		if chunkIndex < len(outputChunks) {
			pty.readBuffer.WriteString(outputChunks[chunkIndex])
			chunkIndex++
		} else {
			pty.setReadError(io.EOF)
		}
	}

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Collect all output
	receivedChunks := []string{}
	ws.SetReadDeadline(time.Now().Add(3 * time.Second))

	for {
		var msg TerminalMessage
		if err := ws.ReadJSON(&msg); err != nil {
			break
		}

		if msg.Type == "output" {
			var output string
			json.Unmarshal(msg.Data, &output)
			receivedChunks = append(receivedChunks, output)
		}
	}

	// Verify all chunks were received before close
	if len(receivedChunks) != len(outputChunks) {
		t.Errorf("Expected %d chunks, got %d", len(outputChunks), len(receivedChunks))
	}

	fullOutput := strings.Join(receivedChunks, "")
	for i, expected := range outputChunks {
		if !strings.Contains(fullOutput, expected) {
			t.Errorf("Missing chunk %d: %q", i, expected)
		}
	}
}

// TestTerminalWebSocket_ConcurrentInputOutput tests concurrent operations
func TestTerminalWebSocket_ConcurrentInputOutput(t *testing.T) {
	t.Skip("TODO: Update to use handleTerminalSession")
	pty := newMockPTY()

	// Continuously produce output
	go func() {
		for i := 0; i < 20; i++ {
			pty.feedOutput(fmt.Sprintf("output %d\n", i))
			time.Sleep(10 * time.Millisecond)
		}
		pty.setReadError(io.EOF)
	}()

	mockProvider := mock.NewProvider()
	mockProvider.AttachFunc = func(_ context.Context, _ string, _ sandbox.AttachOptions) (sandbox.PTY, error) {
		return pty, nil
	}

	testStore := setupTestStore(t)
	sandboxService := service.NewSandboxService(testStore, mockProvider, nil, nil, nil, nil)

	handler := &Handler{
		sandboxService: sandboxService,
		store:          testStore,
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.TerminalWebSocket(w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Concurrently send input and read output
	var wg sync.WaitGroup

	// Sender goroutine
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			inputMsg := TerminalMessage{
				Type: "input",
				Data: json.RawMessage(fmt.Sprintf(`"input %d\n"`, i)),
			}
			ws.WriteJSON(inputMsg)
			time.Sleep(15 * time.Millisecond)
		}
	}()

	// Receiver goroutine
	outputCount := 0
	wg.Add(1)
	go func() {
		defer wg.Done()
		ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			var msg TerminalMessage
			if err := ws.ReadJSON(&msg); err != nil {
				break
			}
			if msg.Type == "output" {
				outputCount++
			}
		}
	}()

	wg.Wait()

	// Verify we received output
	if outputCount == 0 {
		t.Error("Expected to receive output messages")
	}

	// Verify input was written
	written := pty.getWrittenData()
	if !strings.Contains(written, "input 0") {
		t.Error("Expected to receive input")
	}
}

// createMockWebSocketPair creates a pair of connected WebSocket connections for testing.
// Returns (server-side conn, client-side conn).
func createMockWebSocketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()

	// Channel to pass server-side connection
	serverConn := make(chan *websocket.Conn, 1)

	// Create HTTP server that upgrades to WebSocket
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{
			CheckOrigin: func(_ *http.Request) bool { return true },
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("Failed to upgrade: %v", err)
		}
		serverConn <- conn
	}))
	t.Cleanup(func() { server.Close() })

	// Connect client
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to dial: %v", err)
	}

	// Get server-side connection
	serverSide := <-serverConn

	return serverSide, client
}

// setupTestStore creates an in-memory SQLite database for testing
func setupTestStore(t *testing.T) *store.Store {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("failed to create test database: %v", err)
	}

	// Run migrations
	if err := db.AutoMigrate(model.AllModels()...); err != nil {
		t.Fatalf("failed to migrate test database: %v", err)
	}

	return store.New(db)
}
