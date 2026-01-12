package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/anthropics/octobot/server/internal/middleware"
	"github.com/anthropics/octobot/server/internal/oauth"
	"github.com/anthropics/octobot/server/internal/service"
	"github.com/go-chi/chi/v5"
)

// CreateCredentialRequest is the request body for creating/updating a credential
type CreateCredentialRequest struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
	AuthType string `json:"auth_type"` // "api_key" or "oauth"
	APIKey   string `json:"api_key,omitempty"`
}

// ListCredentials returns all credentials for a project (safe info only)
func (h *Handler) ListCredentials(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	credentials, err := h.credentialService.List(r.Context(), projectID)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to list credentials")
		return
	}

	h.JSON(w, http.StatusOK, credentials)
}

// CreateCredential creates or updates a credential
func (h *Handler) CreateCredential(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req CreateCredentialRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Provider == "" {
		h.Error(w, http.StatusBadRequest, "provider is required")
		return
	}

	if req.Name == "" {
		req.Name = req.Provider // Default name to provider
	}

	// Currently only support API key creation via this endpoint
	// OAuth tokens are set via the OAuth flow endpoints
	if req.AuthType == "" || req.AuthType == service.AuthTypeAPIKey {
		if req.APIKey == "" {
			h.Error(w, http.StatusBadRequest, "api_key is required for api_key auth type")
			return
		}

		info, err := h.credentialService.SetAPIKey(r.Context(), projectID, req.Provider, req.Name, req.APIKey)
		if err != nil {
			if errors.Is(err, service.ErrInvalidProvider) {
				h.Error(w, http.StatusBadRequest, "Invalid provider")
				return
			}
			h.Error(w, http.StatusInternalServerError, "Failed to create credential")
			return
		}

		h.JSON(w, http.StatusOK, info)
		return
	}

	h.Error(w, http.StatusBadRequest, "OAuth credentials must be set via OAuth flow endpoints")
}

// GetCredential returns a single credential (safe info only)
func (h *Handler) GetCredential(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())
	provider := chi.URLParam(r, "provider")

	info, err := h.credentialService.Get(r.Context(), projectID, provider)
	if err != nil {
		if errors.Is(err, service.ErrCredentialNotFound) {
			h.Error(w, http.StatusNotFound, "Credential not found")
			return
		}
		h.Error(w, http.StatusInternalServerError, "Failed to get credential")
		return
	}

	h.JSON(w, http.StatusOK, info)
}

// DeleteCredential deletes a credential
func (h *Handler) DeleteCredential(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())
	provider := chi.URLParam(r, "provider")

	if err := h.credentialService.Delete(r.Context(), projectID, provider); err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to delete credential")
		return
	}

	h.JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// AnthropicAuthorizeRequest is the request for starting Anthropic OAuth
type AnthropicAuthorizeRequest struct {
	RedirectURI string `json:"redirect_uri"`
}

// AnthropicExchangeRequest is the request for exchanging code for tokens
type AnthropicExchangeRequest struct {
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	CodeVerifier string `json:"code_verifier"`
}

// AnthropicAuthorize generates PKCE and returns OAuth URL
func (h *Handler) AnthropicAuthorize(w http.ResponseWriter, r *http.Request) {
	var req AnthropicAuthorizeRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.RedirectURI == "" {
		h.Error(w, http.StatusBadRequest, "redirect_uri is required")
		return
	}

	provider := oauth.NewAnthropicProvider(h.cfg.AnthropicClientID)
	authResp, err := provider.Authorize(req.RedirectURI)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to generate authorization URL")
		return
	}

	h.JSON(w, http.StatusOK, authResp)
}

// AnthropicExchange exchanges code for tokens
func (h *Handler) AnthropicExchange(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req AnthropicExchangeRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Code == "" {
		h.Error(w, http.StatusBadRequest, "code is required")
		return
	}
	if req.RedirectURI == "" {
		h.Error(w, http.StatusBadRequest, "redirect_uri is required")
		return
	}
	if req.CodeVerifier == "" {
		h.Error(w, http.StatusBadRequest, "code_verifier is required")
		return
	}

	provider := oauth.NewAnthropicProvider(h.cfg.AnthropicClientID)
	tokenResp, err := provider.Exchange(r.Context(), req.Code, req.RedirectURI, req.CodeVerifier)
	if err != nil {
		h.Error(w, http.StatusBadRequest, "Token exchange failed: "+err.Error())
		return
	}

	// Store the tokens as a credential
	oauthCred := &service.OAuthCredential{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		TokenType:    tokenResp.TokenType,
		ExpiresAt:    tokenResp.ExpiresAt,
		Scope:        tokenResp.Scope,
	}

	info, err := h.credentialService.SetOAuthTokens(r.Context(), projectID, service.ProviderAnthropic, "Anthropic OAuth", oauthCred)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to store credential")
		return
	}

	// Return credential info with token expiration
	response := map[string]interface{}{
		"credential": info,
		"expires_at": tokenResp.ExpiresAt,
	}
	if !tokenResp.ExpiresAt.IsZero() {
		response["expires_in"] = int(time.Until(tokenResp.ExpiresAt).Seconds())
	}

	h.JSON(w, http.StatusOK, response)
}

// GitHubCopilotPollRequest is the request for polling device authorization
type GitHubCopilotPollRequest struct {
	DeviceCode string `json:"device_code"`
}

// GitHubCopilotDeviceCode initiates device flow
func (h *Handler) GitHubCopilotDeviceCode(w http.ResponseWriter, r *http.Request) {
	provider := oauth.NewGitHubCopilotProvider(h.cfg.GitHubCopilotClientID)
	deviceResp, err := provider.RequestDeviceCode(r.Context())
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to request device code: "+err.Error())
		return
	}

	h.JSON(w, http.StatusOK, deviceResp)
}

// GitHubCopilotPoll polls for device authorization
func (h *Handler) GitHubCopilotPoll(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req GitHubCopilotPollRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.DeviceCode == "" {
		h.Error(w, http.StatusBadRequest, "device_code is required")
		return
	}

	provider := oauth.NewGitHubCopilotProvider(h.cfg.GitHubCopilotClientID)
	pollResp, err := provider.PollForToken(r.Context(), req.DeviceCode)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Poll request failed: "+err.Error())
		return
	}

	// Check if authorization is still pending
	if pollResp.IsAuthorizationPending() {
		h.JSON(w, http.StatusAccepted, map[string]string{
			"status": "pending",
			"error":  "authorization_pending",
		})
		return
	}

	// Check for slow down request
	if pollResp.IsSlowDown() {
		h.JSON(w, http.StatusTooManyRequests, map[string]string{
			"status": "slow_down",
			"error":  "slow_down",
		})
		return
	}

	// Check for expired token
	if pollResp.IsExpired() {
		h.Error(w, http.StatusGone, "Device code expired")
		return
	}

	// Check for access denied
	if pollResp.IsAccessDenied() {
		h.Error(w, http.StatusForbidden, "Access denied by user")
		return
	}

	// Check for other errors
	if pollResp.Error != "" {
		h.Error(w, http.StatusBadRequest, pollResp.ErrorDesc)
		return
	}

	// We have a token! Store it
	if !pollResp.HasToken() {
		h.Error(w, http.StatusInternalServerError, "Unexpected response: no token received")
		return
	}

	oauthCred := &service.OAuthCredential{
		AccessToken:  pollResp.AccessToken,
		RefreshToken: pollResp.RefreshToken,
		TokenType:    pollResp.TokenType,
		Scope:        pollResp.Scope,
	}

	info, err := h.credentialService.SetOAuthTokens(r.Context(), projectID, service.ProviderGitHubCopilot, "GitHub Copilot", oauthCred)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to store credential")
		return
	}

	h.JSON(w, http.StatusOK, map[string]interface{}{
		"status":     "authorized",
		"credential": info,
	})
}

// CodexAuthorizeRequest is the request for starting Codex OAuth
type CodexAuthorizeRequest struct {
	RedirectURI string `json:"redirect_uri"`
}

// CodexExchangeRequest is the request for exchanging code for tokens
type CodexExchangeRequest struct {
	Code         string `json:"code"`
	RedirectURI  string `json:"redirect_uri"`
	CodeVerifier string `json:"code_verifier"`
}

// CodexAuthorize generates PKCE and returns OAuth URL
func (h *Handler) CodexAuthorize(w http.ResponseWriter, r *http.Request) {
	var req CodexAuthorizeRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.RedirectURI == "" {
		h.Error(w, http.StatusBadRequest, "redirect_uri is required")
		return
	}

	provider := oauth.NewCodexProvider(h.cfg.CodexClientID)
	authResp, err := provider.Authorize(req.RedirectURI)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to generate authorization URL")
		return
	}

	h.JSON(w, http.StatusOK, authResp)
}

// CodexExchange exchanges code for tokens
func (h *Handler) CodexExchange(w http.ResponseWriter, r *http.Request) {
	projectID := middleware.GetProjectID(r.Context())

	var req CodexExchangeRequest
	if err := h.DecodeJSON(r, &req); err != nil {
		h.Error(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Code == "" {
		h.Error(w, http.StatusBadRequest, "code is required")
		return
	}
	if req.RedirectURI == "" {
		h.Error(w, http.StatusBadRequest, "redirect_uri is required")
		return
	}
	if req.CodeVerifier == "" {
		h.Error(w, http.StatusBadRequest, "code_verifier is required")
		return
	}

	provider := oauth.NewCodexProvider(h.cfg.CodexClientID)
	tokenResp, err := provider.Exchange(r.Context(), req.Code, req.RedirectURI, req.CodeVerifier)
	if err != nil {
		h.Error(w, http.StatusBadRequest, "Token exchange failed: "+err.Error())
		return
	}

	// Store the tokens as a credential
	oauthCred := &service.OAuthCredential{
		AccessToken:  tokenResp.AccessToken,
		RefreshToken: tokenResp.RefreshToken,
		TokenType:    tokenResp.TokenType,
		ExpiresAt:    tokenResp.ExpiresAt,
		Scope:        tokenResp.Scope,
	}

	info, err := h.credentialService.SetOAuthTokens(r.Context(), projectID, service.ProviderCodex, "OpenAI Codex", oauthCred)
	if err != nil {
		h.Error(w, http.StatusInternalServerError, "Failed to store credential")
		return
	}

	// Return credential info with token expiration
	response := map[string]interface{}{
		"credential": info,
		"expires_at": tokenResp.ExpiresAt,
	}
	if !tokenResp.ExpiresAt.IsZero() {
		response["expires_in"] = int(time.Until(tokenResp.ExpiresAt).Seconds())
	}

	h.JSON(w, http.StatusOK, response)
}
