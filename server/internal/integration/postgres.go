package integration

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	// PostgreSQL container settings
	postgresContainerName = "octobot-test-postgres"
	postgresPort          = "5433" // Non-standard port to avoid conflicts
	postgresUser          = "octobot"
	postgresPassword      = "octobot"
	postgresDB            = "octobot_test"
	postgresImage         = "postgres:16-alpine"
)

// PostgresDSN returns the DSN for the test PostgreSQL container
func PostgresDSN() string {
	return fmt.Sprintf("postgres://%s:%s@localhost:%s/%s?sslmode=disable",
		postgresUser, postgresPassword, postgresPort, postgresDB)
}

// PostgresEnabled returns true if TEST_POSTGRES=1 is set
func PostgresEnabled() bool {
	return os.Getenv("TEST_POSTGRES") == "1"
}

// StartPostgres starts a PostgreSQL container for testing.
// It removes any existing container first to ensure a fresh database.
// Returns a cleanup function that should be called when tests complete.
func StartPostgres() (cleanup func(success bool), err error) {
	// Always remove existing container first for fresh database
	_ = removePostgresContainer()

	// Start new container
	if err := startPostgresContainer(); err != nil {
		return nil, fmt.Errorf("failed to start postgres container: %w", err)
	}

	// Wait for PostgreSQL to be ready
	if err := waitForPostgres(30 * time.Second); err != nil {
		// Don't remove on startup failure - might want to debug
		return nil, fmt.Errorf("postgres failed to become ready: %w", err)
	}

	cleanup = func(success bool) {
		if success {
			// Remove container on success
			if err := removePostgresContainer(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to remove postgres container: %v\n", err)
			}
		} else {
			// Keep container on failure for debugging
			separator := strings.Repeat("=", 60)
			fmt.Fprintf(os.Stderr, "\n%s\n", separator)
			fmt.Fprintf(os.Stderr, "TEST FAILED - PostgreSQL container kept for debugging\n")
			fmt.Fprintf(os.Stderr, "Container: %s\n", postgresContainerName)
			fmt.Fprintf(os.Stderr, "Connect:   psql %s\n", PostgresDSN())
			fmt.Fprintf(os.Stderr, "Remove:    docker rm -f %s\n", postgresContainerName)
			fmt.Fprintf(os.Stderr, "%s\n\n", separator)
		}
	}

	return cleanup, nil
}

func startPostgresContainer() error {
	cmd := exec.Command("docker", "run",
		"-d",
		"--name", postgresContainerName,
		"-p", postgresPort+":5432",
		"-e", "POSTGRES_USER="+postgresUser,
		"-e", "POSTGRES_PASSWORD="+postgresPassword,
		"-e", "POSTGRES_DB="+postgresDB,
		postgresImage,
	)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%w: %s", err, stderr.String())
	}

	return nil
}

func removePostgresContainer() error {
	cmd := exec.Command("docker", "rm", "-f", postgresContainerName)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func waitForPostgres(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", "localhost:"+postgresPort, time.Second)
		if err == nil {
			conn.Close()

			// Port is open, but PostgreSQL might not be ready yet
			// Try to connect with psql
			cmd := exec.Command("docker", "exec", postgresContainerName,
				"pg_isready", "-U", postgresUser, "-d", postgresDB)
			if cmd.Run() == nil {
				// pg_isready succeeded, but we need to ensure external connections work
				// Add a small delay to let the port mapping stabilize
				time.Sleep(500 * time.Millisecond)

				// Verify we can actually connect from outside the container
				verifyConn, verifyErr := net.DialTimeout("tcp", "localhost:"+postgresPort, time.Second)
				if verifyErr == nil {
					verifyConn.Close()
					return nil
				}
			}
		}

		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("timeout waiting for postgres on port %s", postgresPort)
}

// ContainerExists checks if the postgres test container exists
func ContainerExists() bool {
	cmd := exec.Command("docker", "inspect", postgresContainerName)
	return cmd.Run() == nil
}
