package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// Default GitHub domain
	DefaultGitHubDomain = "github.com"
)

// GitHubCopilotProvider handles GitHub Copilot device code flow.
type GitHubCopilotProvider struct {
	ClientID string
	Domain   string // e.g., "github.com" or "github.mycompany.com"
	Scopes   []string
}

// deviceCodeURL returns the device code endpoint for this provider's domain
func (p *GitHubCopilotProvider) deviceCodeURL() string {
	return "https://" + p.Domain + "/login/device/code"
}

// tokenURL returns the token endpoint for this provider's domain
func (p *GitHubCopilotProvider) tokenURL() string {
	return "https://" + p.Domain + "/login/oauth/access_token"
}

// DeviceCodeResponse represents the initial device code response.
type DeviceCodeResponse struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

// DevicePollResponse represents a polling response (success or pending).
type DevicePollResponse struct {
	AccessToken  string    `json:"access_token,omitempty"`
	TokenType    string    `json:"token_type,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	Error        string    `json:"error,omitempty"`
	ErrorDesc    string    `json:"error_description,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
}

// NewGitHubCopilotProvider creates a new GitHub Copilot device flow provider.
// If domain is empty, defaults to github.com.
func NewGitHubCopilotProvider(clientID, domain string) *GitHubCopilotProvider {
	if domain == "" {
		domain = DefaultGitHubDomain
	}
	return &GitHubCopilotProvider{
		ClientID: clientID,
		Domain:   domain,
		// Copilot-specific scopes
		Scopes: []string{"read:user"},
	}
}

// RequestDeviceCode initiates the device code flow.
func (p *GitHubCopilotProvider) RequestDeviceCode(ctx context.Context) (*DeviceCodeResponse, error) {
	data := url.Values{}
	data.Set("client_id", p.ClientID)
	data.Set("scope", strings.Join(p.Scopes, " "))

	req, err := http.NewRequestWithContext(ctx, "POST", p.deviceCodeURL(), strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("device code request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("device code request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var deviceResp DeviceCodeResponse
	if err := json.Unmarshal(body, &deviceResp); err != nil {
		return nil, fmt.Errorf("failed to parse device code response: %w", err)
	}

	return &deviceResp, nil
}

// PollForToken polls the token endpoint to check if the user has authorized.
// Returns the token response if authorized, or an error string like "authorization_pending".
func (p *GitHubCopilotProvider) PollForToken(ctx context.Context, deviceCode string) (*DevicePollResponse, error) {
	data := url.Values{}
	data.Set("client_id", p.ClientID)
	data.Set("device_code", deviceCode)
	data.Set("grant_type", "urn:ietf:params:oauth:grant-type:device_code")

	req, err := http.NewRequestWithContext(ctx, "POST", p.tokenURL(), strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token poll request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var pollResp DevicePollResponse
	if err := json.Unmarshal(body, &pollResp); err != nil {
		return nil, fmt.Errorf("failed to parse poll response: %w", err)
	}

	return &pollResp, nil
}

// IsAuthorizationPending returns true if the poll response indicates the user hasn't authorized yet.
func (r *DevicePollResponse) IsAuthorizationPending() bool {
	return r.Error == "authorization_pending"
}

// IsSlowDown returns true if we should increase the polling interval.
func (r *DevicePollResponse) IsSlowDown() bool {
	return r.Error == "slow_down"
}

// IsExpired returns true if the device code has expired.
func (r *DevicePollResponse) IsExpired() bool {
	return r.Error == "expired_token"
}

// IsAccessDenied returns true if the user denied authorization.
func (r *DevicePollResponse) IsAccessDenied() bool {
	return r.Error == "access_denied"
}

// HasToken returns true if the response contains a valid access token.
func (r *DevicePollResponse) HasToken() bool {
	return r.AccessToken != "" && r.Error == ""
}
