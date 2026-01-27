package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDeriveSessionName(t *testing.T) {
	tests := []struct {
		name     string
		messages json.RawMessage
		expected string
	}{
		{
			name:     "empty messages",
			messages: json.RawMessage("[]"),
			expected: "New Session",
		},
		{
			name:     "null messages",
			messages: nil,
			expected: "New Session",
		},
		{
			name: "simple user message",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "Hello, world!"}
					]
				}
			]`),
			expected: "Hello, world!",
		},
		{
			name: "long message not truncated",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "This is a very long message that is definitely more than 50 characters long and should not be truncated"}
					]
				}
			]`),
			expected: "This is a very long message that is definitely more than 50 characters long and should not be truncated",
		},
		{
			name: "message with leading and trailing whitespace",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "  \n  Test message with whitespace  \t  "}
					]
				}
			]`),
			expected: "Test message with whitespace",
		},
		{
			name: "message with newlines in the middle",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "First line\nSecond line\nThird line"}
					]
				}
			]`),
			expected: "First line\nSecond line\nThird line",
		},
		{
			name: "assistant message first, then user message",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "assistant",
					"parts": [
						{"type": "text", "text": "Assistant message"}
					]
				},
				{
					"id": "msg-2",
					"role": "user",
					"parts": [
						{"type": "text", "text": "User message"}
					]
				}
			]`),
			expected: "User message",
		},
		{
			name: "user message with multiple parts",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "image", "data": "..."},
						{"type": "text", "text": "This is the text part"}
					]
				}
			]`),
			expected: "This is the text part",
		},
		{
			name: "user message with empty text part",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": ""}
					]
				}
			]`),
			expected: "New Session",
		},
		{
			name: "user message with only whitespace",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "   \n\t   "}
					]
				}
			]`),
			expected: "New Session",
		},
		{
			name: "user message with no text parts",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "image", "data": "..."}
					]
				}
			]`),
			expected: "New Session",
		},
		{
			name:     "invalid JSON",
			messages: json.RawMessage(`not valid json`),
			expected: "New Session",
		},
		{
			name: "very long message (100+ chars)",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "` + strings.Repeat("a", 200) + `"}
					]
				}
			]`),
			expected: strings.Repeat("a", 200),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := deriveSessionName(tt.messages)
			if result != tt.expected {
				t.Errorf("deriveSessionName() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestDeriveSessionName_RealWorldExamples(t *testing.T) {
	tests := []struct {
		name     string
		messages json.RawMessage
		expected string
	}{
		{
			name: "typical coding request",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "Help me fix the authentication bug in the login handler"}
					]
				}
			]`),
			expected: "Help me fix the authentication bug in the login handler",
		},
		{
			name: "multi-line code request",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "Can you help me with this:\n\n1. Add error handling\n2. Improve performance\n3. Add unit tests"}
					]
				}
			]`),
			expected: "Can you help me with this:\n\n1. Add error handling\n2. Improve performance\n3. Add unit tests",
		},
		{
			name: "question with code block",
			messages: json.RawMessage(`[
				{
					"id": "msg-1",
					"role": "user",
					"parts": [
						{"type": "text", "text": "Why is this code failing?\n\nfunc example() {\n  // code here\n}"}
					]
				}
			]`),
			expected: "Why is this code failing?\n\nfunc example() {\n  // code here\n}",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := deriveSessionName(tt.messages)
			if result != tt.expected {
				t.Errorf("deriveSessionName() = %q, want %q", result, tt.expected)
			}
		})
	}
}
