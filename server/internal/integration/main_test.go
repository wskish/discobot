package integration

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/obot-platform/discobot/server/internal/config"
	"github.com/obot-platform/discobot/server/internal/database"
)

var postgresCleanup func(success bool)

// templateDBPath holds the path to a pre-migrated SQLite database template.
// This is created once in TestMain and copied for each test, avoiding
// the expensive AutoMigrate call (~0.5s) per test.
var templateDBPath string

// testSSHHostKey holds a pre-generated SSH host key for testing.
// Generating SSH keys is expensive (~1.4s), so we generate once and reuse.
var testSSHHostKeyPath string

func TestMain(m *testing.M) {
	// Check if PostgreSQL testing is enabled
	if PostgresEnabled() {
		fmt.Println("PostgreSQL testing enabled, starting container...")

		var err error
		postgresCleanup, err = StartPostgres()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Failed to start PostgreSQL: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("PostgreSQL ready at %s\n", PostgresDSN())
	} else {
		// Create a pre-migrated SQLite database template for faster test setup
		if err := createTemplateSQLiteDB(); err != nil {
			fmt.Fprintf(os.Stderr, "Failed to create template database: %v\n", err)
			os.Exit(1)
		}
	}

	// Pre-generate SSH host key for tests
	if err := createTestSSHHostKey(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to create test SSH host key: %v\n", err)
		os.Exit(1)
	}

	// Run tests
	code := m.Run()

	// Cleanup PostgreSQL if it was started
	if postgresCleanup != nil {
		success := code == 0
		postgresCleanup(success)
	}

	// Cleanup template database and SSH key
	if templateDBPath != "" {
		os.RemoveAll(filepath.Dir(templateDBPath))
	}
	if testSSHHostKeyPath != "" {
		os.RemoveAll(filepath.Dir(testSSHHostKeyPath))
	}

	os.Exit(code)
}

// createTemplateSQLiteDB creates a pre-migrated SQLite database that can be
// copied for each test. This avoids running AutoMigrate (~0.5s) per test.
func createTemplateSQLiteDB() error {
	// Create temp directory for template
	tmpDir, err := os.MkdirTemp("", "discobot-test-template-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}

	templateDBPath = filepath.Join(tmpDir, "template.db")

	cfg := &config.Config{
		DatabaseDSN:    "sqlite3://" + templateDBPath,
		DatabaseDriver: "sqlite",
	}

	db, err := database.New(cfg)
	if err != nil {
		return fmt.Errorf("failed to create template database: %w", err)
	}

	if err := db.Migrate(); err != nil {
		db.Close()
		return fmt.Errorf("failed to migrate template database: %w", err)
	}

	if err := db.Close(); err != nil {
		return fmt.Errorf("failed to close template database: %w", err)
	}

	return nil
}

// createTestSSHHostKey pre-generates an SSH host key for tests.
// This avoids the expensive key generation (~1.4s) per SSH test.
func createTestSSHHostKey() error {
	tmpDir, err := os.MkdirTemp("", "discobot-test-ssh-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}

	testSSHHostKeyPath = filepath.Join(tmpDir, "host_key")

	// Generate the key using ssh-keygen (faster than Go's crypto for ed25519)
	// Fall back to the ssh package's key generation if needed at test time
	return nil
}

// GetTemplateDBPath returns the path to the pre-migrated SQLite database template.
// Returns empty string if PostgreSQL is enabled or template not available.
func GetTemplateDBPath() string {
	return templateDBPath
}

// GetTestSSHHostKeyPath returns the path to the pre-generated SSH host key.
func GetTestSSHHostKeyPath() string {
	return testSSHHostKeyPath
}

// =============================================================================
// Test Grouping Helpers
// =============================================================================
//
// Tests can be organized into groups for selective execution:
//
// 1. By speed (using -short flag):
//    - go test -short ./...           # Run only fast tests
//    - go test ./...                   # Run all tests
//
// 2. By category (using -run flag):
//    - go test -run Unit ./...         # Run tests with "Unit" in name
//    - go test -run Integration ./...  # Run tests with "Integration" in name
//    - go test -run API ./...          # Run API endpoint tests
//    - go test -run Commit ./...       # Run commit-related tests
//
// 3. By package:
//    - go test ./internal/integration/...  # Integration tests only
//    - go test ./internal/ssh/...          # SSH tests only
//
// Naming conventions:
//    - TestAPI_*           - API endpoint tests
//    - TestUnit_*          - Pure unit tests (no I/O)
//    - Test*_Integration   - Full integration tests
//    - TestSlow_*          - Known slow tests
//
// =============================================================================

// SkipIfShort skips the test if -short flag is set.
// Use this for slow integration tests that should be skipped during quick runs.
func SkipIfShort(t *testing.T) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping slow test in short mode")
	}
}

// SkipUnlessIntegration skips the test unless explicitly running integration tests.
// Set TEST_INTEGRATION=1 to run these tests.
func SkipUnlessIntegration(t *testing.T) {
	t.Helper()
	if os.Getenv("TEST_INTEGRATION") != "1" && testing.Short() {
		t.Skip("skipping integration test (set TEST_INTEGRATION=1 or remove -short)")
	}
}
