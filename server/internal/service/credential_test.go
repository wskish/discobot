package service

import (
	"context"
	"testing"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/providers"
)

func TestGetAllDecrypted_AnthropicOAuth_UsesCorrectEnvVar(t *testing.T) {
	// Create in-memory store
	st := setupTestStore(t)

	// Create config with encryption key (must be 32 bytes for AES-256)
	cfg := &config.Config{
		EncryptionKey: []byte("test-key-32-bytes-long-123456789"),
	}

	// Create credential service
	credSvc, err := NewCredentialService(st, cfg)
	if err != nil {
		t.Fatalf("Failed to create credential service: %v", err)
	}

	ctx := context.Background()
	projectID := "test-project"

	// Verify Anthropic provider has API key env var
	envVars := providers.GetEnvVars(ProviderAnthropic)
	if len(envVars) < 1 {
		t.Fatalf("Expected Anthropic provider to have at least 1 env var, got %d", len(envVars))
	}
	if envVars[0] != "ANTHROPIC_API_KEY" {
		t.Errorf("Expected first env var to be ANTHROPIC_API_KEY, got %s", envVars[0])
	}

	// Create an OAuth credential for Anthropic
	oauthTokens := &OAuthCredential{
		AccessToken: "oauth-token-test-123",
		TokenType:   "Bearer",
	}
	oauthInfo, err := credSvc.SetOAuthTokens(ctx, projectID, ProviderAnthropic, "OAuth Token", oauthTokens)
	if err != nil {
		t.Fatalf("Failed to set OAuth tokens: %v", err)
	}
	if oauthInfo.AuthType != AuthTypeOAuth {
		t.Errorf("Expected auth type %s, got %s", AuthTypeOAuth, oauthInfo.AuthType)
	}

	// Get all decrypted credentials
	envVarMappings, err := credSvc.GetAllDecrypted(ctx, projectID)
	if err != nil {
		t.Fatalf("Failed to get all decrypted: %v", err)
	}

	// Should have 1 mapping (OAuth)
	if len(envVarMappings) != 1 {
		t.Fatalf("Expected 1 env var mapping, got %d", len(envVarMappings))
	}

	// Verify it uses CLAUDE_CODE_OAUTH_TOKEN (second env var for Anthropic OAuth)
	if envVarMappings[0].EnvVar != "CLAUDE_CODE_OAUTH_TOKEN" {
		t.Errorf("Expected env var CLAUDE_CODE_OAUTH_TOKEN, got %s", envVarMappings[0].EnvVar)
	}
	if envVarMappings[0].Value != "oauth-token-test-123" {
		t.Errorf("Expected value 'oauth-token-test-123', got %s", envVarMappings[0].Value)
	}
}

func TestGetAllDecrypted_AnthropicAPIKey_UsesCorrectEnvVar(t *testing.T) {
	// Create in-memory store
	st := setupTestStore(t)

	// Create config with encryption key (must be 32 bytes for AES-256)
	cfg := &config.Config{
		EncryptionKey: []byte("test-key-32-bytes-long-123456789"),
	}

	// Create credential service
	credSvc, err := NewCredentialService(st, cfg)
	if err != nil {
		t.Fatalf("Failed to create credential service: %v", err)
	}

	ctx := context.Background()
	projectID := "test-project"

	// Verify Anthropic provider has API key env var
	envVars := providers.GetEnvVars(ProviderAnthropic)
	if len(envVars) < 1 {
		t.Fatalf("Expected Anthropic provider to have at least 1 env var, got %d", len(envVars))
	}
	if envVars[0] != "ANTHROPIC_API_KEY" {
		t.Errorf("Expected first env var to be ANTHROPIC_API_KEY, got %s", envVars[0])
	}

	// Create an API key credential for Anthropic
	apiKeyInfo, err := credSvc.SetAPIKey(ctx, projectID, ProviderAnthropic, "API Key", "sk-ant-test-123")
	if err != nil {
		t.Fatalf("Failed to set API key: %v", err)
	}
	if apiKeyInfo.AuthType != AuthTypeAPIKey {
		t.Errorf("Expected auth type %s, got %s", AuthTypeAPIKey, apiKeyInfo.AuthType)
	}

	// Get all decrypted credentials
	envVarMappings, err := credSvc.GetAllDecrypted(ctx, projectID)
	if err != nil {
		t.Fatalf("Failed to get all decrypted: %v", err)
	}

	// Should have 1 mapping (API key)
	if len(envVarMappings) != 1 {
		t.Fatalf("Expected 1 env var mapping, got %d", len(envVarMappings))
	}

	// Verify it uses ANTHROPIC_API_KEY (first env var for Anthropic API key)
	if envVarMappings[0].EnvVar != "ANTHROPIC_API_KEY" {
		t.Errorf("Expected env var ANTHROPIC_API_KEY, got %s", envVarMappings[0].EnvVar)
	}
	if envVarMappings[0].Value != "sk-ant-test-123" {
		t.Errorf("Expected value 'sk-ant-test-123', got %s", envVarMappings[0].Value)
	}
}

func TestGetAllDecrypted_OtherProviderOAuth_UsesFirstEnvVar(t *testing.T) {
	// Create in-memory store
	st := setupTestStore(t)

	// Create config with encryption key (must be 32 bytes for AES-256)
	cfg := &config.Config{
		EncryptionKey: []byte("test-key-32-bytes-long-123456789"),
	}

	// Create credential service
	credSvc, err := NewCredentialService(st, cfg)
	if err != nil {
		t.Fatalf("Failed to create credential service: %v", err)
	}

	ctx := context.Background()
	projectID := "test-project"

	// Create an OAuth credential for GitHub Copilot
	oauthTokens := &OAuthCredential{
		AccessToken: "github-copilot-token",
		TokenType:   "Bearer",
	}
	_, err = credSvc.SetOAuthTokens(ctx, projectID, ProviderGitHubCopilot, "GitHub Copilot OAuth", oauthTokens)
	if err != nil {
		t.Fatalf("Failed to set OAuth tokens: %v", err)
	}

	// Get all decrypted credentials
	envVarMappings, err := credSvc.GetAllDecrypted(ctx, projectID)
	if err != nil {
		t.Fatalf("Failed to get all decrypted: %v", err)
	}

	// Should have 1 mapping
	if len(envVarMappings) != 1 {
		t.Fatalf("Expected 1 env var mapping, got %d", len(envVarMappings))
	}

	// Verify it uses GITHUB_TOKEN (first env var for GitHub Copilot)
	if envVarMappings[0].EnvVar != "GITHUB_TOKEN" {
		t.Errorf("Expected env var GITHUB_TOKEN, got %s", envVarMappings[0].EnvVar)
	}
	if envVarMappings[0].Value != "github-copilot-token" {
		t.Errorf("Expected value 'github-copilot-token', got %s", envVarMappings[0].Value)
	}
}
