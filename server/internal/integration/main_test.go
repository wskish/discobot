package integration

import (
	"fmt"
	"os"
	"testing"
)

var postgresCleanup func(success bool)

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
	}

	// Run tests
	code := m.Run()

	// Cleanup PostgreSQL if it was started
	if postgresCleanup != nil {
		success := code == 0
		postgresCleanup(success)
	}

	os.Exit(code)
}
