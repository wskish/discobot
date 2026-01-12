package config

import (
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config holds all configuration for the server
type Config struct {
	// Server settings
	Port        int
	CORSOrigins []string

	// Database
	DatabaseDSN    string
	DatabaseDriver string // "postgres" or "sqlite3", auto-detected from DSN

	// Authentication
	AuthEnabled bool // If false, uses anonymous user (default: false)

	// Security
	SessionSecret []byte
	EncryptionKey []byte // 32 bytes for AES-256-GCM

	// Workspaces
	WorkspaceDir string

	// Docker/Container settings
	ContainerIdleTimeout time.Duration

	// OAuth providers (for user login)
	GitHubClientID     string
	GitHubClientSecret string
	GoogleClientID     string
	GoogleClientSecret string

	// AI Provider OAuth (client IDs are public for PKCE flows)
	AnthropicClientID     string
	GitHubCopilotClientID string
	CodexClientID         string
}

// Load reads configuration from environment variables
func Load() (*Config, error) {
	cfg := &Config{}

	// Server
	cfg.Port = getEnvInt("PORT", 8080)
	cfg.CORSOrigins = getEnvList("CORS_ORIGINS", []string{"http://localhost:3000"})

	// Database
	cfg.DatabaseDSN = getEnv("DATABASE_DSN", "sqlite3://./octobot.db")
	cfg.DatabaseDriver = detectDriver(cfg.DatabaseDSN)

	// Authentication - defaults to disabled (anonymous user mode)
	cfg.AuthEnabled = getEnvBool("AUTH_ENABLED", false)

	// Security - Session secret (required only if auth is enabled)
	sessionSecret := getEnv("SESSION_SECRET", "")
	if sessionSecret == "" {
		if cfg.AuthEnabled {
			return nil, fmt.Errorf("SESSION_SECRET is required when AUTH_ENABLED=true")
		}
		// Use a default for no-auth mode (sessions still work but aren't secure)
		sessionSecret = "octobot-dev-session-secret-not-for-production"
	}
	cfg.SessionSecret = []byte(sessionSecret)

	// Security - Encryption key (32 bytes for AES-256)
	encryptionKeyStr := getEnv("ENCRYPTION_KEY", "")
	if encryptionKeyStr == "" {
		if cfg.AuthEnabled {
			return nil, fmt.Errorf("ENCRYPTION_KEY is required when AUTH_ENABLED=true (32 bytes, hex encoded)")
		}
		// Use a default for no-auth mode (credentials still encrypted but key isn't secure)
		encryptionKeyStr = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	}
	encryptionKey, err := hex.DecodeString(encryptionKeyStr)
	if err != nil {
		return nil, fmt.Errorf("ENCRYPTION_KEY must be hex encoded: %w", err)
	}
	if len(encryptionKey) != 32 {
		return nil, fmt.Errorf("ENCRYPTION_KEY must be exactly 32 bytes (64 hex chars), got %d bytes", len(encryptionKey))
	}
	cfg.EncryptionKey = encryptionKey

	// Workspaces
	cfg.WorkspaceDir = getEnv("WORKSPACE_DIR", "./workspaces")

	// Container settings
	cfg.ContainerIdleTimeout = getEnvDuration("CONTAINER_IDLE_TIMEOUT", 30*time.Minute)

	// OAuth providers for user login
	cfg.GitHubClientID = getEnv("GITHUB_CLIENT_ID", "")
	cfg.GitHubClientSecret = getEnv("GITHUB_CLIENT_SECRET", "")
	cfg.GoogleClientID = getEnv("GOOGLE_CLIENT_ID", "")
	cfg.GoogleClientSecret = getEnv("GOOGLE_CLIENT_SECRET", "")

	// AI Provider OAuth client IDs (public, used in PKCE flows)
	cfg.AnthropicClientID = getEnv("ANTHROPIC_CLIENT_ID", "9d1c250a-e61b-44d9-88ed-5944d1962f5e")
	cfg.GitHubCopilotClientID = getEnv("GITHUB_COPILOT_CLIENT_ID", "Iv1.b507a08c87ecfe98")
	cfg.CodexClientID = getEnv("CODEX_CLIENT_ID", "app_EMoamEEZ73f0CkXaXp7hrann")

	return cfg, nil
}

// detectDriver determines the database driver from DSN
func detectDriver(dsn string) string {
	if strings.HasPrefix(dsn, "postgres://") || strings.HasPrefix(dsn, "postgresql://") {
		return "postgres"
	}
	if strings.HasPrefix(dsn, "sqlite3://") || strings.HasPrefix(dsn, "sqlite://") {
		return "sqlite"
	}
	// Default to sqlite for file paths
	if strings.HasSuffix(dsn, ".db") || strings.HasSuffix(dsn, ".sqlite") {
		return "sqlite"
	}
	return "postgres"
}

// CleanDSN removes the driver prefix from DSN for database/sql
func (c *Config) CleanDSN() string {
	dsn := c.DatabaseDSN
	dsn = strings.TrimPrefix(dsn, "postgres://")
	dsn = strings.TrimPrefix(dsn, "postgresql://")
	dsn = strings.TrimPrefix(dsn, "sqlite3://")
	dsn = strings.TrimPrefix(dsn, "sqlite://")

	// For postgres, add the prefix back
	if c.DatabaseDriver == "postgres" {
		return "postgres://" + dsn
	}
	return dsn
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}

func getEnvList(key string, defaultValue []string) []string {
	if value := os.Getenv(key); value != "" {
		return strings.Split(value, ",")
	}
	return defaultValue
}

func getEnvDuration(key string, defaultValue time.Duration) time.Duration {
	if value := os.Getenv(key); value != "" {
		if d, err := time.ParseDuration(value); err == nil {
			return d
		}
	}
	return defaultValue
}
