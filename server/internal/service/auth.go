package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/github"
	"golang.org/x/oauth2/google"

	"github.com/anthropics/octobot/server/internal/config"
	"github.com/anthropics/octobot/server/internal/model"
	"github.com/anthropics/octobot/server/internal/store"
)

// AuthService handles authentication operations
type AuthService struct {
	store        *store.Store
	cfg          *config.Config
	githubConfig *oauth2.Config
	googleConfig *oauth2.Config
}

// User represents an authenticated user (for API responses)
type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Provider  string `json:"provider"`
}

// NewAuthService creates a new auth service
func NewAuthService(s *store.Store, cfg *config.Config) *AuthService {
	svc := &AuthService{
		store: s,
		cfg:   cfg,
	}

	// Configure GitHub OAuth
	if cfg.GitHubClientID != "" {
		svc.githubConfig = &oauth2.Config{
			ClientID:     cfg.GitHubClientID,
			ClientSecret: cfg.GitHubClientSecret,
			Scopes:       []string{"user:email", "read:user"},
			Endpoint:     github.Endpoint,
		}
	}

	// Configure Google OAuth
	if cfg.GoogleClientID != "" {
		svc.googleConfig = &oauth2.Config{
			ClientID:     cfg.GoogleClientID,
			ClientSecret: cfg.GoogleClientSecret,
			Scopes:       []string{"email", "profile"},
			Endpoint:     google.Endpoint,
		}
	}

	return svc
}

// GetAuthURL returns the OAuth authorization URL for a provider
func (s *AuthService) GetAuthURL(provider, redirectURL, state string) (string, error) {
	config, err := s.getOAuthConfig(provider, redirectURL)
	if err != nil {
		return "", err
	}
	return config.AuthCodeURL(state, oauth2.AccessTypeOffline), nil
}

// ExchangeCode exchanges an authorization code for user info
func (s *AuthService) ExchangeCode(ctx context.Context, provider, redirectURL, code string) (*User, error) {
	config, err := s.getOAuthConfig(provider, redirectURL)
	if err != nil {
		return nil, err
	}

	token, err := config.Exchange(ctx, code)
	if err != nil {
		return nil, fmt.Errorf("failed to exchange code: %w", err)
	}

	// Get user info from provider
	switch provider {
	case "github":
		return s.getGitHubUser(ctx, token)
	case "google":
		return s.getGoogleUser(ctx, token)
	default:
		return nil, fmt.Errorf("unsupported provider: %s", provider)
	}
}

// CreateOrUpdateUser creates or updates a user in the database
func (s *AuthService) CreateOrUpdateUser(ctx context.Context, user *User) (*User, error) {
	// Check if user exists
	existing, err := s.store.GetUserByProviderID(ctx, user.Provider, user.ID)
	if err == nil {
		// Update existing user
		existing.Name = strPtr(user.Name)
		existing.AvatarURL = strPtr(user.AvatarURL)
		if err := s.store.UpdateUser(ctx, existing); err != nil {
			return nil, fmt.Errorf("failed to update user: %w", err)
		}
		return &User{
			ID:        existing.ID,
			Email:     existing.Email,
			Name:      ptrToString(existing.Name),
			AvatarURL: ptrToString(existing.AvatarURL),
			Provider:  existing.Provider,
		}, nil
	}

	// Create new user
	newUser := &model.User{
		Email:      user.Email,
		Name:       strPtr(user.Name),
		AvatarURL:  strPtr(user.AvatarURL),
		Provider:   user.Provider,
		ProviderID: user.ID,
	}
	if err := s.store.CreateUser(ctx, newUser); err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	return &User{
		ID:        newUser.ID,
		Email:     newUser.Email,
		Name:      ptrToString(newUser.Name),
		AvatarURL: ptrToString(newUser.AvatarURL),
		Provider:  newUser.Provider,
	}, nil
}

// CreateSession creates a new session for a user and returns the token
func (s *AuthService) CreateSession(ctx context.Context, userID string) (string, error) {
	// Generate random token
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	token := base64.URLEncoding.EncodeToString(tokenBytes)

	// Hash token for storage
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])

	// Set expiry (30 days)
	expiresAt := time.Now().Add(30 * 24 * time.Hour)

	session := &model.UserSession{
		UserID:    userID,
		TokenHash: tokenHash,
		ExpiresAt: expiresAt,
	}
	if err := s.store.CreateUserSession(ctx, session); err != nil {
		return "", fmt.Errorf("failed to create session: %w", err)
	}

	return token, nil
}

// ValidateSession validates a session token and returns the user
func (s *AuthService) ValidateSession(ctx context.Context, token string) (*User, error) {
	// Hash token
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])

	session, err := s.store.GetUserSessionByToken(ctx, tokenHash)
	if err != nil {
		return nil, fmt.Errorf("invalid session: %w", err)
	}

	// Check if session is expired
	if session.ExpiresAt.Before(time.Now()) {
		return nil, fmt.Errorf("session expired")
	}

	// Get user - if preloaded, use that; otherwise fetch
	var user *model.User
	if session.User != nil {
		user = session.User
	} else {
		user, err = s.store.GetUserByID(ctx, session.UserID)
		if err != nil {
			return nil, fmt.Errorf("user not found: %w", err)
		}
	}

	return &User{
		ID:        user.ID,
		Email:     user.Email,
		Name:      ptrToString(user.Name),
		AvatarURL: ptrToString(user.AvatarURL),
		Provider:  user.Provider,
	}, nil
}

// DeleteSession deletes a session by token
func (s *AuthService) DeleteSession(ctx context.Context, token string) error {
	hash := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hash[:])
	return s.store.DeleteUserSession(ctx, tokenHash)
}

// GetUserByID retrieves a user by ID
func (s *AuthService) GetUserByID(ctx context.Context, userID string) (*User, error) {
	user, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &User{
		ID:        user.ID,
		Email:     user.Email,
		Name:      ptrToString(user.Name),
		AvatarURL: ptrToString(user.AvatarURL),
		Provider:  user.Provider,
	}, nil
}

func (s *AuthService) getOAuthConfig(provider, redirectURL string) (*oauth2.Config, error) {
	var config *oauth2.Config
	switch provider {
	case "github":
		if s.githubConfig == nil {
			return nil, fmt.Errorf("GitHub OAuth not configured")
		}
		config = &oauth2.Config{
			ClientID:     s.githubConfig.ClientID,
			ClientSecret: s.githubConfig.ClientSecret,
			Scopes:       s.githubConfig.Scopes,
			Endpoint:     s.githubConfig.Endpoint,
			RedirectURL:  redirectURL,
		}
	case "google":
		if s.googleConfig == nil {
			return nil, fmt.Errorf("google OAuth not configured")
		}
		config = &oauth2.Config{
			ClientID:     s.googleConfig.ClientID,
			ClientSecret: s.googleConfig.ClientSecret,
			Scopes:       s.googleConfig.Scopes,
			Endpoint:     s.googleConfig.Endpoint,
			RedirectURL:  redirectURL,
		}
	default:
		return nil, fmt.Errorf("unsupported provider: %s", provider)
	}
	return config, nil
}

func (s *AuthService) getGitHubUser(ctx context.Context, token *oauth2.Token) (*User, error) {
	client := oauth2.NewClient(ctx, oauth2.StaticTokenSource(token))

	// Get user info
	resp, err := client.Get("https://api.github.com/user")
	if err != nil {
		return nil, fmt.Errorf("failed to get user info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("GitHub API error: %s", string(body))
	}

	var ghUser struct {
		ID        int    `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&ghUser); err != nil {
		return nil, fmt.Errorf("failed to decode user info: %w", err)
	}

	// If email is not public, fetch from emails endpoint
	email := ghUser.Email
	if email == "" {
		email, err = s.getGitHubEmail(ctx, client)
		if err != nil {
			return nil, err
		}
	}

	name := ghUser.Name
	if name == "" {
		name = ghUser.Login
	}

	return &User{
		ID:        fmt.Sprintf("%d", ghUser.ID),
		Email:     email,
		Name:      name,
		AvatarURL: ghUser.AvatarURL,
		Provider:  "github",
	}, nil
}

func (s *AuthService) getGitHubEmail(_ context.Context, client *http.Client) (string, error) {
	resp, err := client.Get("https://api.github.com/user/emails")
	if err != nil {
		return "", fmt.Errorf("failed to get emails: %w", err)
	}
	defer resp.Body.Close()

	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return "", fmt.Errorf("failed to decode emails: %w", err)
	}

	// Find primary verified email
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email, nil
		}
	}

	// Fall back to any verified email
	for _, e := range emails {
		if e.Verified {
			return e.Email, nil
		}
	}

	return "", fmt.Errorf("no verified email found")
}

func (s *AuthService) getGoogleUser(ctx context.Context, token *oauth2.Token) (*User, error) {
	client := oauth2.NewClient(ctx, oauth2.StaticTokenSource(token))

	resp, err := client.Get("https://www.googleapis.com/oauth2/v2/userinfo")
	if err != nil {
		return nil, fmt.Errorf("failed to get user info: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("google API error: %s", string(body))
	}

	var googleUser struct {
		ID      string `json:"id"`
		Email   string `json:"email"`
		Name    string `json:"name"`
		Picture string `json:"picture"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&googleUser); err != nil {
		return nil, fmt.Errorf("failed to decode user info: %w", err)
	}

	return &User{
		ID:        googleUser.ID,
		Email:     googleUser.Email,
		Name:      googleUser.Name,
		AvatarURL: googleUser.Picture,
		Provider:  "google",
	}, nil
}

// GenerateState generates a random state for OAuth
func GenerateState() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// Helper functions for null handling
func ptrToString(s *string) string {
	if s != nil {
		return *s
	}
	return ""
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
