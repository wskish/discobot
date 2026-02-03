package handler

import (
	"encoding/json"
	"testing"
)

// TestTerminalANSIEncoding verifies that ANSI escape codes are correctly
// preserved through JSON encoding and can be properly interpreted by terminal clients.
// This is a regression test for a bug where escape codes were being displayed as
// literal text like "[36m" instead of being interpreted as color codes.
func TestTerminalANSIEncoding(t *testing.T) {
	testCases := []struct {
		name     string
		input    []byte
		expected string
	}{
		{
			name:     "ANSI color codes (cyan)",
			input:    []byte("\x1b[36m[agent-watcher 07:24:39]\x1b[0m Dockerfile changed"),
			expected: "\x1b[36m[agent-watcher 07:24:39]\x1b[0m Dockerfile changed",
		},
		{
			name:     "Multiple ANSI codes",
			input:    []byte("\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[34mBlue\x1b[0m"),
			expected: "\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m \x1b[34mBlue\x1b[0m",
		},
		{
			name:     "ANSI bold and underline",
			input:    []byte("\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m"),
			expected: "\x1b[1mBold\x1b[0m \x1b[4mUnderline\x1b[0m",
		},
		{
			name:     "Plain text without ANSI",
			input:    []byte("Hello, World!"),
			expected: "Hello, World!",
		},
		{
			name:     "Text with newlines",
			input:    []byte("Line 1\nLine 2\r\nLine 3"),
			expected: "Line 1\nLine 2\r\nLine 3",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			// Create terminal message using json.Marshal (the correct approach)
			jsonData, err := json.Marshal(string(tc.input))
			if err != nil {
				t.Fatalf("json.Marshal failed: %v", err)
			}

			msg := TerminalMessage{
				Type: "output",
				Data: json.RawMessage(jsonData),
			}

			// Simulate what happens when sent over WebSocket
			wireFormat, err := json.Marshal(msg)
			if err != nil {
				t.Fatalf("Failed to marshal message: %v", err)
			}

			// Simulate client receiving and parsing the message
			var received struct {
				Type string `json:"type"`
				Data string `json:"data"`
			}
			if err := json.Unmarshal(wireFormat, &received); err != nil {
				t.Fatalf("Client unmarshal failed: %v", err)
			}

			// Verify the data matches what we sent
			if received.Data != tc.expected {
				t.Errorf("Data mismatch:\n  Expected: %q\n  Got:      %q", tc.expected, received.Data)
			}

			// For ANSI codes, specifically verify the ESC character is preserved
			if len(tc.input) > 0 && tc.input[0] == '\x1b' {
				if len(received.Data) == 0 || received.Data[0] != '\x1b' {
					t.Errorf("ESC character (0x1b) was not preserved")
					if len(received.Data) > 0 {
						t.Errorf("  First byte: 0x%02x", received.Data[0])
					}
				}
			}
		})
	}
}

// TestTerminalMessageJSONEncoding tests that TerminalMessage JSON encoding
// produces valid JSON that correctly represents binary data.
func TestTerminalMessageJSONEncoding(t *testing.T) {
	t.Run("Escape_character_encoding", func(t *testing.T) {
		// ESC[36m = cyan color ANSI code
		input := []byte{0x1b, '[', '3', '6', 'm'}

		// Use json.Marshal to create proper JSON
		jsonData, err := json.Marshal(string(input))
		if err != nil {
			t.Fatalf("json.Marshal failed: %v", err)
		}

		t.Logf("JSON output: %s", string(jsonData))

		// Verify json.Marshal produced valid JSON with quotes
		if len(jsonData) < 2 || jsonData[0] != '"' || jsonData[len(jsonData)-1] != '"' {
			t.Error("json.Marshal should produce quoted JSON string")
		}

		// Parse the JSON back
		var parsed string
		if err := json.Unmarshal(jsonData, &parsed); err != nil {
			t.Fatalf("Unmarshal failed: %v", err)
		}

		// Verify ESC character is preserved
		if len(parsed) < 1 || parsed[0] != '\x1b' {
			t.Errorf("Expected ESC character (0x1b), got: 0x%02x", parsed[0])
		}

		// Verify full sequence is intact
		expected := "\x1b[36m"
		if parsed != expected {
			t.Errorf("Expected %q, got %q", expected, parsed)
		}
	})

	t.Run("Full_message_round_trip", func(t *testing.T) {
		// Real-world example from the bug report
		output := []byte("\x1b[36m[agent-watcher 07:24:39]\x1b[0m Dockerfile changed")

		jsonData, err := json.Marshal(string(output))
		if err != nil {
			t.Fatalf("json.Marshal failed: %v", err)
		}

		msg := TerminalMessage{
			Type: "output",
			Data: json.RawMessage(jsonData),
		}

		// Full round trip: marshal -> unmarshal
		wireFormat, err := json.Marshal(msg)
		if err != nil {
			t.Fatalf("Marshal message failed: %v", err)
		}

		var received struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(wireFormat, &received); err != nil {
			t.Fatalf("Unmarshal message failed: %v", err)
		}

		// Verify complete data integrity
		expected := string(output)
		if received.Data != expected {
			t.Errorf("Round-trip data mismatch:\n  Expected: %q\n  Got:      %q", expected, received.Data)
		}

		// Verify ESC characters are present and correct
		escCount := 0
		for i := 0; i < len(received.Data); i++ {
			if received.Data[i] == '\x1b' {
				escCount++
			}
		}
		if escCount != 2 {
			t.Errorf("Expected 2 ESC characters, found %d", escCount)
		}
	})
}
