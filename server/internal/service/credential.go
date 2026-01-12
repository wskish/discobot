package service

import (
	"context"
	"errors"
	"time"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/crypto"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// Supported providers
const (
	ProviderAnthropic     = "anthropic"
	ProviderGitHubCopilot = "github-copilot"
	ProviderCodex         = "codex"
	ProviderOpenAI        = "openai"
)

// Auth types
const (
	AuthTypeAPIKey = "api_key"
	AuthTypeOAuth  = "oauth"
)

var (
	ErrCredentialNotFound = errors.New("credential not found")
	ErrInvalidProvider    = errors.New("invalid provider")
	ErrEncryptionFailed   = errors.New("encryption failed")
	ErrDecryptionFailed   = errors.New("decryption failed")
)

// APIKeyCredential represents an API key credential
type APIKeyCredential struct {
	APIKey string `json:"api_key"`
}

// OAuthCredential represents OAuth tokens
type OAuthCredential struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type,omitempty"`
	ExpiresAt    time.Time `json:"expires_at,omitempty"`
	Scope        string    `json:"scope,omitempty"`
}

// CredentialInfo represents safe credential info for API responses (no secrets)
type CredentialInfo struct {
	ID           string    `json:"id"`
	Provider     string    `json:"provider"`
	Name         string    `json:"name"`
	AuthType     string    `json:"auth_type"`
	IsConfigured bool      `json:"is_configured"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// CredentialService handles credential operations with encryption
type CredentialService struct {
	store     *store.Store
	cfg       *config.Config
	encryptor *crypto.Encryptor
}

// NewCredentialService creates a new credential service
func NewCredentialService(s *store.Store, cfg *config.Config) (*CredentialService, error) {
	enc, err := crypto.NewEncryptor(cfg.EncryptionKey)
	if err != nil {
		return nil, err
	}

	return &CredentialService{
		store:     s,
		cfg:       cfg,
		encryptor: enc,
	}, nil
}

// List returns all credentials for a project (safe info only, no secrets)
func (s *CredentialService) List(ctx context.Context, projectID string) ([]CredentialInfo, error) {
	creds, err := s.store.ListCredentialsByProject(ctx, projectID)
	if err != nil {
		return nil, err
	}

	result := make([]CredentialInfo, len(creds))
	for i, c := range creds {
		result[i] = toCredentialInfo(c)
	}
	return result, nil
}

// Get returns credential info for a specific provider (safe info only, no secrets)
func (s *CredentialService) Get(ctx context.Context, projectID, provider string) (*CredentialInfo, error) {
	cred, err := s.store.GetCredentialByProvider(ctx, projectID, provider)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrCredentialNotFound
		}
		return nil, err
	}

	info := toCredentialInfo(cred)
	return &info, nil
}

// SetAPIKey creates or updates an API key credential
func (s *CredentialService) SetAPIKey(ctx context.Context, projectID, provider, name, apiKey string) (*CredentialInfo, error) {
	if !isValidProvider(provider) {
		return nil, ErrInvalidProvider
	}

	// Encrypt the API key
	data := APIKeyCredential{APIKey: apiKey}
	encrypted, err := s.encryptor.EncryptJSON(data)
	if err != nil {
		return nil, ErrEncryptionFailed
	}

	// Check if credential already exists
	existing, err := s.store.GetCredentialByProvider(ctx, projectID, provider)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	if existing != nil {
		// Update existing
		existing.Name = name
		existing.AuthType = AuthTypeAPIKey
		existing.EncryptedData = encrypted
		existing.IsConfigured = true
		if err := s.store.UpdateCredential(ctx, existing); err != nil {
			return nil, err
		}
		info := toCredentialInfo(existing)
		return &info, nil
	}

	// Create new
	cred := &model.Credential{
		ProjectID:     projectID,
		Provider:      provider,
		Name:          name,
		AuthType:      AuthTypeAPIKey,
		EncryptedData: encrypted,
		IsConfigured:  true,
	}
	if err := s.store.CreateCredential(ctx, cred); err != nil {
		return nil, err
	}

	info := toCredentialInfo(cred)
	return &info, nil
}

// SetOAuthTokens creates or updates OAuth tokens for a credential
func (s *CredentialService) SetOAuthTokens(ctx context.Context, projectID, provider, name string, tokens *OAuthCredential) (*CredentialInfo, error) {
	if !isValidProvider(provider) {
		return nil, ErrInvalidProvider
	}

	// Encrypt the tokens
	encrypted, err := s.encryptor.EncryptJSON(tokens)
	if err != nil {
		return nil, ErrEncryptionFailed
	}

	// Check if credential already exists
	existing, err := s.store.GetCredentialByProvider(ctx, projectID, provider)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}

	if existing != nil {
		// Update existing
		existing.Name = name
		existing.AuthType = AuthTypeOAuth
		existing.EncryptedData = encrypted
		existing.IsConfigured = true
		if err := s.store.UpdateCredential(ctx, existing); err != nil {
			return nil, err
		}
		info := toCredentialInfo(existing)
		return &info, nil
	}

	// Create new
	cred := &model.Credential{
		ProjectID:     projectID,
		Provider:      provider,
		Name:          name,
		AuthType:      AuthTypeOAuth,
		EncryptedData: encrypted,
		IsConfigured:  true,
	}
	if err := s.store.CreateCredential(ctx, cred); err != nil {
		return nil, err
	}

	info := toCredentialInfo(cred)
	return &info, nil
}

// GetAPIKey retrieves and decrypts an API key credential
func (s *CredentialService) GetAPIKey(ctx context.Context, projectID, provider string) (*APIKeyCredential, error) {
	cred, err := s.store.GetCredentialByProvider(ctx, projectID, provider)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrCredentialNotFound
		}
		return nil, err
	}

	if cred.AuthType != AuthTypeAPIKey {
		return nil, errors.New("credential is not an API key type")
	}

	var data APIKeyCredential
	if err := s.encryptor.DecryptJSON(cred.EncryptedData, &data); err != nil {
		return nil, ErrDecryptionFailed
	}

	return &data, nil
}

// GetOAuthTokens retrieves and decrypts OAuth tokens
func (s *CredentialService) GetOAuthTokens(ctx context.Context, projectID, provider string) (*OAuthCredential, error) {
	cred, err := s.store.GetCredentialByProvider(ctx, projectID, provider)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrCredentialNotFound
		}
		return nil, err
	}

	if cred.AuthType != AuthTypeOAuth {
		return nil, errors.New("credential is not an OAuth type")
	}

	var tokens OAuthCredential
	if err := s.encryptor.DecryptJSON(cred.EncryptedData, &tokens); err != nil {
		return nil, ErrDecryptionFailed
	}

	return &tokens, nil
}

// Delete removes a credential
func (s *CredentialService) Delete(ctx context.Context, projectID, provider string) error {
	return s.store.DeleteCredential(ctx, projectID, provider)
}

// isValidProvider checks if a provider is supported
func isValidProvider(provider string) bool {
	switch provider {
	case ProviderAnthropic, ProviderGitHubCopilot, ProviderCodex, ProviderOpenAI:
		return true
	default:
		return false
	}
}

// toCredentialInfo converts a model.Credential to CredentialInfo (safe for API)
func toCredentialInfo(c *model.Credential) CredentialInfo {
	return CredentialInfo{
		ID:           c.ID,
		Provider:     c.Provider,
		Name:         c.Name,
		AuthType:     c.AuthType,
		IsConfigured: c.IsConfigured,
		CreatedAt:    c.CreatedAt,
		UpdatedAt:    c.UpdatedAt,
	}
}
