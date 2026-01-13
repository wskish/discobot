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
	// Anthropic OAuth endpoints (Claude Max flow via claude.ai)
	anthropicAuthURL     = "https://claude.ai/oauth/authorize"
	anthropicTokenURL    = "https://console.anthropic.com/v1/oauth/token"
	anthropicRedirectURI = "https://console.anthropic.com/oauth/code/callback"
)

// AnthropicProvider handles Anthropic OAuth 2.0 with PKCE.
type AnthropicProvider struct {
	ClientID string
	Scopes   []string
}

// AuthorizeResponse contains the data needed to redirect the user to Anthropic.
type AuthorizeResponse struct {
	URL                 string `json:"url"`
	State               string `json:"state"`
	Verifier            string `json:"verifier"`
	CodeChallenge       string `json:"codeChallenge"`
	CodeChallengeMethod string `json:"codeChallengeMethod"`
}

// ExchangeRequest represents the token exchange request.
type ExchangeRequest struct {
	Code         string `json:"code"`
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
		Scopes:   []string{"org:create_api_key", "user:profile", "user:inference"},
	}
}

// Authorize generates the authorization URL and PKCE challenge.
// Note: Following the reference implementation, we use the PKCE verifier as the state parameter.
// This is because the callback returns code#state, and state needs to match the verifier.
func (p *AnthropicProvider) Authorize() (*AuthorizeResponse, error) {
	// Generate PKCE challenge
	pkce, err := GeneratePKCE()
	if err != nil {
		return nil, fmt.Errorf("failed to generate PKCE: %w", err)
	}

	// Build authorization URL
	// Use verifier as state (matches reference implementation)
	params := url.Values{}
	params.Set("code", "true")
	params.Set("response_type", "code")
	params.Set("client_id", p.ClientID)
	params.Set("redirect_uri", anthropicRedirectURI)
	params.Set("scope", strings.Join(p.Scopes, " "))
	params.Set("state", pkce.CodeVerifier)
	params.Set("code_challenge", pkce.CodeChallenge)
	params.Set("code_challenge_method", pkce.CodeChallengeMethod)

	authURL := anthropicAuthURL + "?" + params.Encode()

	return &AuthorizeResponse{
		URL:                 authURL,
		State:               pkce.CodeVerifier,
		Verifier:            pkce.CodeVerifier,
		CodeChallenge:       pkce.CodeChallenge,
		CodeChallengeMethod: pkce.CodeChallengeMethod,
	}, nil
}

// Exchange exchanges an authorization code for tokens.
func (p *AnthropicProvider) Exchange(ctx context.Context, code, codeVerifier string) (*TokenResponse, error) {
	// The code may have a state appended after #
	actualCode := code
	state := codeVerifier
	if parts := strings.SplitN(code, "#", 2); len(parts) == 2 {
		actualCode = parts[0]
		state = parts[1]
	}

	// Build token request as JSON (Anthropic expects JSON, not form-encoded)
	reqBody := map[string]string{
		"code":          actualCode,
		"state":         state,
		"grant_type":    "authorization_code",
		"client_id":     p.ClientID,
		"redirect_uri":  anthropicRedirectURI,
		"code_verifier": codeVerifier,
	}
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", anthropicTokenURL, strings.NewReader(string(jsonBody)))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

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
