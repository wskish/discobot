package middleware

import (
	"net/url"
	"testing"
)

func TestRedactSensitiveParams(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "URL with token parameter",
			input:    "/api/preferences?token=vWM1DoU5h9ucUgZMckc8pJqhx2VX2e0U",
			expected: "/api/preferences?token=%5BREDACTED%5D",
		},
		{
			name:     "URL with multiple parameters including token",
			input:    "/api/data?foo=bar&token=secret123&baz=qux",
			expected: "/api/data?baz=qux&foo=bar&token=%5BREDACTED%5D",
		},
		{
			name:     "URL with password parameter",
			input:    "/api/login?username=admin&password=secret",
			expected: "/api/login?password=%5BREDACTED%5D&username=admin",
		},
		{
			name:     "URL with api_key parameter",
			input:    "/api/data?api_key=1234567890",
			expected: "/api/data?api_key=%5BREDACTED%5D",
		},
		{
			name:     "URL with apiKey parameter",
			input:    "/api/data?apiKey=1234567890",
			expected: "/api/data?apiKey=%5BREDACTED%5D",
		},
		{
			name:     "URL with secret parameter",
			input:    "/api/config?secret=topsecret&other=value",
			expected: "/api/config?other=value&secret=%5BREDACTED%5D",
		},
		{
			name:     "URL with multiple sensitive parameters",
			input:    "/api/auth?token=abc&password=def&api_key=ghi",
			expected: "/api/auth?api_key=%5BREDACTED%5D&password=%5BREDACTED%5D&token=%5BREDACTED%5D",
		},
		{
			name:     "URL with no sensitive parameters",
			input:    "/api/data?foo=bar&baz=qux",
			expected: "/api/data?foo=bar&baz=qux",
		},
		{
			name:     "URL with no query parameters",
			input:    "/api/data",
			expected: "/api/data",
		},
		{
			name:     "URL with empty query string",
			input:    "/api/data?",
			expected: "/api/data",
		},
		{
			name:     "URL with encoded special characters in token",
			input:    "/api/data?token=abc%2Bdef%3Dghi",
			expected: "/api/data?token=%5BREDACTED%5D",
		},
		{
			name:     "Root path with token",
			input:    "/?token=secret",
			expected: "/?token=%5BREDACTED%5D",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := url.Parse(tt.input)
			if err != nil {
				t.Fatalf("Failed to parse URL: %v", err)
			}

			result := redactSensitiveParams(u)
			if result != tt.expected {
				t.Errorf("redactSensitiveParams() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestRedactSensitiveParamsWithFullURL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Full URL with token",
			input:    "http://localhost:3001/api/preferences?token=vWM1DoU5h9ucUgZMckc8pJqhx2VX2e0U",
			expected: "/api/preferences?token=%5BREDACTED%5D",
		},
		{
			name:     "HTTPS URL with api_key",
			input:    "https://example.com/api/data?api_key=secret123&foo=bar",
			expected: "/api/data?api_key=%5BREDACTED%5D&foo=bar",
		},
		{
			name:     "URL with port and token",
			input:    "http://localhost:8080/api/auth?token=abc123",
			expected: "/api/auth?token=%5BREDACTED%5D",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := url.Parse(tt.input)
			if err != nil {
				t.Fatalf("Failed to parse URL: %v", err)
			}

			result := redactSensitiveParams(u)
			if result != tt.expected {
				t.Errorf("redactSensitiveParams() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestRedactSensitiveParamsCaseSensitivity(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "Token with uppercase",
			input:    "/api/data?Token=secret",
			expected: "/api/data?Token=secret", // Case-sensitive, not redacted
		},
		{
			name:     "PASSWORD with all caps",
			input:    "/api/data?PASSWORD=secret",
			expected: "/api/data?PASSWORD=secret", // Case-sensitive, not redacted
		},
		{
			name:     "Mixed case token",
			input:    "/api/data?token=secret123",
			expected: "/api/data?token=%5BREDACTED%5D", // Exact match, redacted
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, err := url.Parse(tt.input)
			if err != nil {
				t.Fatalf("Failed to parse URL: %v", err)
			}

			result := redactSensitiveParams(u)
			if result != tt.expected {
				t.Errorf("redactSensitiveParams() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func BenchmarkRedactSensitiveParams(b *testing.B) {
	testURL, _ := url.Parse("/api/preferences?token=vWM1DoU5h9ucUgZMckc8pJqhx2VX2e0U&foo=bar&baz=qux")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		redactSensitiveParams(testURL)
	}
}

func BenchmarkRedactSensitiveParamsNoRedaction(b *testing.B) {
	testURL, _ := url.Parse("/api/data?foo=bar&baz=qux&other=value")

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		redactSensitiveParams(testURL)
	}
}
