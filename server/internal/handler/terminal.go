package handler

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/obot-platform/discobot/server/internal/sandbox"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(_ *http.Request) bool {
		// TODO: Implement proper origin checking based on config
		return true
	},
}

// TerminalMessage represents a message sent over the WebSocket
type TerminalMessage struct {
	Type string          `json:"type"` // "input", "output", "resize", "error"
	Data json.RawMessage `json:"data,omitempty"`
}

// ResizeData contains terminal resize dimensions
type ResizeData struct {
	Rows int `json:"rows"`
	Cols int `json:"cols"`
}

// TerminalWebSocket handles WebSocket terminal connections
func (h *Handler) TerminalWebSocket(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "session ID is required")
		return
	}

	if h.sandboxService == nil {
		h.Error(w, http.StatusServiceUnavailable, "sandbox provider not available")
		return
	}

	// Get terminal dimensions from query params
	rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
	cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
	if rows == 0 {
		rows = 24
	}
	if cols == 0 {
		cols = 80
	}

	// Check if root access is requested
	runAsRoot := r.URL.Query().Get("root") == "true"

	ctx := r.Context()

	// Get sandbox client (ensures sandbox is ready and container is running)
	client, err := h.sandboxService.GetClient(ctx, sessionID)
	if err != nil {
		log.Printf("failed to ensure sandbox ready for session %s: %v", sessionID, err)
		h.Error(w, http.StatusInternalServerError, "failed to start sandbox")
		return
	}

	// Determine user for terminal session
	var user string
	if runAsRoot {
		user = "root"
	} else {
		// Get default user from sandbox (uses UID:GID format for compatibility)
		userInfo, err := client.GetUserInfo(ctx)
		if err != nil {
			log.Printf("failed to get user info, falling back to root: %v", err)
			user = "root"
		} else {
			user = strconv.Itoa(userInfo.UID) + ":" + strconv.Itoa(userInfo.GID)
		}
	}

	// Upgrade to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("failed to upgrade websocket: %v", err)
		return
	}
	defer func() { _ = conn.Close() }()

	// Attach to sandbox PTY
	pty, err := h.sandboxService.Attach(ctx, sessionID, rows, cols, user)
	if err != nil {
		log.Printf("failed to attach to sandbox PTY: %v", err)
		sendError(conn, "failed to attach to terminal")
		return
	}
	defer func() { _ = pty.Close() }()

	// Handle the terminal session (core logic extracted for testability)
	handleTerminalSession(ctx, pty, conn)
}

// handleTerminalSession manages the bidirectional data flow between PTY and WebSocket.
// This function is extracted from TerminalWebSocket for testability.
//
// Goroutine coordination:
//   - Input goroutine: Reads from WebSocket, writes to PTY. Exits when client stops writing.
//   - Output goroutine: Reads from PTY, writes to WebSocket. Exits when PTY exits.
//
// Half-close support:
//   - If client stops writing, input goroutine exits but output continues.
//   - If PTY exits, both goroutines eventually exit and connection closes.
func handleTerminalSession(ctx context.Context, pty sandbox.PTY, conn *websocket.Conn) {
	// Done channel to signal when PTY output is fully drained
	outputDone := make(chan struct{})

	// WebSocket -> PTY (input)
	// Exits silently when client stops writing, allowing output to continue (half-close support)
	go func() {
		for {
			var msg TerminalMessage
			if err := conn.ReadJSON(&msg); err != nil {
				// Client closed or network error - stop reading input
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("WebSocket read error: %v", err)
				}
				return
			}

			switch msg.Type {
			case "input":
				var input string
				if err := json.Unmarshal(msg.Data, &input); err != nil {
					log.Printf("failed to unmarshal input: %v", err)
					continue
				}
				if _, err := pty.Write([]byte(input)); err != nil {
					log.Printf("PTY write error: %v", err)
					return
				}

			case "resize":
				var resize ResizeData
				if err := json.Unmarshal(msg.Data, &resize); err != nil {
					log.Printf("failed to unmarshal resize: %v", err)
					continue
				}
				if err := pty.Resize(ctx, resize.Rows, resize.Cols); err != nil {
					log.Printf("PTY resize error: %v", err)
				}
			}
		}
	}()

	// PTY -> WebSocket (output)
	// Continues until PTY exits, even if client stops writing (half-close support)
	go func() {
		defer close(outputDone)
		buf := make([]byte, 4096)
		for {
			n, err := pty.Read(buf)
			if err != nil {
				if err != io.EOF {
					log.Printf("PTY read error: %v", err)
				}
				return
			}
			if n > 0 {
				// Properly JSON-encode the data to preserve ANSI escape codes
				data, err := json.Marshal(string(buf[:n]))
				if err != nil {
					log.Printf("JSON marshal error: %v", err)
					return
				}
				msg := TerminalMessage{
					Type: "output",
					Data: json.RawMessage(data),
				}
				if err := conn.WriteJSON(msg); err != nil {
					log.Printf("WebSocket write error: %v", err)
					return
				}
			}
		}
	}()

	// Wait for PTY to exit (shell exits)
	exitCode, _ := pty.Wait(ctx)
	log.Printf("PTY exited with code: %d", exitCode)

	// Wait for output to be fully drained before closing
	<-outputDone

	// Send a close message to the client before closing the connection
	// This ensures the frontend receives a proper close event
	closeMsg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shell exited")
	_ = conn.WriteControl(websocket.CloseMessage, closeMsg, time.Now().Add(time.Second))
}

// GetTerminalHistory returns terminal history for a session
func (h *Handler) GetTerminalHistory(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "session ID is required")
		return
	}

	// Get limit from query params, default to 100
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 100
	}

	ctx := r.Context()
	history, err := h.store.ListTerminalHistory(ctx, sessionID, limit)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "failed to get terminal history")
		return
	}

	h.JSON(w, http.StatusOK, map[string]any{"history": history})
}

// GetTerminalStatus returns the sandbox status
func (h *Handler) GetTerminalStatus(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	if sessionID == "" {
		h.Error(w, http.StatusBadRequest, "session ID is required")
		return
	}

	if h.sandboxService == nil {
		h.JSON(w, http.StatusOK, map[string]string{
			"status": "unavailable",
			"error":  "sandbox provider not configured",
		})
		return
	}

	ctx := r.Context()
	sb, err := h.sandboxService.GetForSession(ctx, sessionID)
	if err != nil {
		if err == sandbox.ErrNotFound {
			h.JSON(w, http.StatusOK, map[string]string{"status": "not_created"})
			return
		}
		h.Error(w, http.StatusInternalServerError, "failed to get sandbox status")
		return
	}

	response := map[string]any{
		"status":    string(sb.Status),
		"image":     sb.Image,
		"createdAt": sb.CreatedAt.Format(time.RFC3339),
	}
	if sb.StartedAt != nil {
		response["startedAt"] = sb.StartedAt.Format(time.RFC3339)
	}
	if sb.StoppedAt != nil {
		response["stoppedAt"] = sb.StoppedAt.Format(time.RFC3339)
	}
	if sb.Error != "" {
		response["error"] = sb.Error
	}

	h.JSON(w, http.StatusOK, response)
}

// sendError sends an error message over the WebSocket
func sendError(conn *websocket.Conn, message string) {
	msg := TerminalMessage{
		Type: "error",
		Data: json.RawMessage(`"` + message + `"`),
	}
	_ = conn.WriteJSON(msg)
}
