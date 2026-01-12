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
	// Anthropic OAuth endpoints
	anthropicAuthURL  = "https://console.anthropic.com/oauth/authorize"
	anthropicTokenURL = "https://api.anthropic.com/oauth/token"
)

// AnthropicProvider handles Anthropic OAuth 2.0 with PKCE.
type AnthropicProvider struct {
	ClientID    string
	RedirectURI string
	Scopes      []string
}

// AuthorizeRequest represents the data needed to start an Anthropic OAuth flow.
type AuthorizeRequest struct {
	RedirectURI string `json:"redirect_uri"`
}

// AuthorizeResponse contains the data needed to redirect the user to Anthropic.
type AuthorizeResponse struct {
	AuthURL             string `json:"auth_url"`
	State               string `json:"state"`
	CodeVerifier        string `json:"code_verifier"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
}

// ExchangeRequest represents the token exchange request.
type ExchangeRequest struct {
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	CodeVerifier string `json:"code_verifier"`
}

// TokenResponse represents the OAuth token response.
type TokenResponse struct {
	AccessToken  string    `json:"access_token"`
	TokenType    string    `json:"token_type"`
	ExpiresIn    int       `json:"expires_in,omitempty"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
}

// NewAnthropicProvider creates a new Anthropic OAuth provider.
func NewAnthropicProvider(clientID string) *AnthropicProvider {
	return &AnthropicProvider{
		ClientID: clientID,
		Scopes:   []string{"api"},
	}
}

// Authorize generates the authorization URL and PKCE challenge.
func (p *AnthropicProvider) Authorize(redirectURI string) (*AuthorizeResponse, error) {
	// Generate PKCE challenge
	pkce, err := GeneratePKCE()
	if err != nil {
		return nil, fmt.Errorf("failed to generate PKCE: %w", err)
	}

	// Generate state
	state, err := GenerateState()
	if err != nil {
		return nil, fmt.Errorf("failed to generate state: %w", err)
	}

	// Build authorization URL
	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", p.ClientID)
	params.Set("redirect_uri", redirectURI)
	params.Set("scope", strings.Join(p.Scopes, " "))
	params.Set("state", state)
	params.Set("code_challenge", pkce.CodeChallenge)
	params.Set("code_challenge_method", pkce.CodeChallengeMethod)

	authURL := anthropicAuthURL + "?" + params.Encode()

	return &AuthorizeResponse{
		AuthURL:             authURL,
		State:               state,
		CodeVerifier:        pkce.CodeVerifier,
		CodeChallenge:       pkce.CodeChallenge,
		CodeChallengeMethod: pkce.CodeChallengeMethod,
	}, nil
}

// Exchange exchanges an authorization code for tokens.
func (p *AnthropicProvider) Exchange(ctx context.Context, code, redirectURI, codeVerifier string) (*TokenResponse, error) {
	// Build token request
	data := url.Values{}
	data.Set("grant_type", "authorization_code")
	data.Set("client_id", p.ClientID)
	data.Set("code", code)
	data.Set("redirect_uri", redirectURI)
	data.Set("code_verifier", codeVerifier)

	req, err := http.NewRequestWithContext(ctx, "POST", anthropicTokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("token request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token request failed with status %d: %s", resp.StatusCode, string(body))
	}

	var tokenResp TokenResponse
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		return nil, fmt.Errorf("failed to parse token response: %w", err)
	}

	// Calculate expiration time if ExpiresIn is provided
	if tokenResp.ExpiresIn > 0 {
		tokenResp.ExpiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
	}

	return &tokenResp, nil
}
