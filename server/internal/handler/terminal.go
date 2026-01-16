package handler

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"github.com/obot-platform/octobot/server/internal/sandbox"
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

	ctx := r.Context()

	// Ensure sandbox is running
	// EnsureRunning will retrieve workspace path from the session
	if err := h.sandboxService.EnsureRunning(ctx, sessionID); err != nil {
		log.Printf("failed to ensure sandbox running for session %s: %v", sessionID, err)
		h.Error(w, http.StatusInternalServerError, "failed to start sandbox")
		return
	}

	// Upgrade to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("failed to upgrade websocket: %v", err)
		return
	}
	defer func() { _ = conn.Close() }()

	// Attach to sandbox PTY
	pty, err := h.sandboxService.Attach(ctx, sessionID, rows, cols)
	if err != nil {
		log.Printf("failed to attach to sandbox PTY: %v", err)
		sendError(conn, "failed to attach to terminal")
		return
	}
	defer func() { _ = pty.Close() }()

	// Create a context for cancellation
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)

	// PTY -> WebSocket (output)
	go func() {
		defer wg.Done()
		defer cancel()
		buf := make([]byte, 4096)
		for {
			select {
			case <-ctx.Done():
				return
			default:
				n, err := pty.Read(buf)
				if err != nil {
					if err != io.EOF {
						log.Printf("PTY read error: %v", err)
					}
					return
				}
				if n > 0 {
					msg := TerminalMessage{
						Type: "output",
						Data: json.RawMessage(`"` + escapeForJSON(buf[:n]) + `"`),
					}
					if err := conn.WriteJSON(msg); err != nil {
						log.Printf("WebSocket write error: %v", err)
						return
					}
				}
			}
		}
	}()

	// WebSocket -> PTY (input)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			default:
				var msg TerminalMessage
				if err := conn.ReadJSON(&msg); err != nil {
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
		}
	}()

	wg.Wait()
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

// escapeForJSON escapes binary data for JSON string
func escapeForJSON(data []byte) string {
	// Use base64 for binary data to avoid JSON escaping issues
	// The client should decode this
	result := make([]byte, 0, len(data)*2)
	for _, b := range data {
		switch b {
		case '"':
			result = append(result, '\\', '"')
		case '\\':
			result = append(result, '\\', '\\')
		case '\n':
			result = append(result, '\\', 'n')
		case '\r':
			result = append(result, '\\', 'r')
		case '\t':
			result = append(result, '\\', 't')
		default:
			if b < 32 || b > 126 {
				// Escape non-printable characters
				result = append(result, '\\', 'u', '0', '0',
					"0123456789abcdef"[b>>4],
					"0123456789abcdef"[b&0xf])
			} else {
				result = append(result, b)
			}
		}
	}
	return string(result)
}
