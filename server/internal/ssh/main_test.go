package ssh

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/obot-platform/octobot/server/internal/sandbox/mock"
)

// sharedTestKeyPath is a pre-generated SSH host key for tests that don't
// specifically need to test key generation. This avoids the expensive
// RSA 4096-bit key generation (~1.4s) for each test.
var sharedTestKeyPath string
var sharedTestKeyDir string

func TestMain(m *testing.M) {
	// Pre-generate SSH host key for tests
	var err error
	sharedTestKeyDir, err = os.MkdirTemp("", "ssh-test-*")
	if err != nil {
		os.Stderr.WriteString("Failed to create temp dir: " + err.Error() + "\n")
		os.Exit(1)
	}

	sharedTestKeyPath = filepath.Join(sharedTestKeyDir, "test_host_key")

	// Generate the key by creating a temporary server (it will generate the key)
	provider := mock.NewProvider()
	srv, err := New(&Config{
		Address:         ":0",
		HostKeyPath:     sharedTestKeyPath,
		SandboxProvider: provider,
	})
	if err != nil {
		os.Stderr.WriteString("Failed to generate test host key: " + err.Error() + "\n")
		os.Exit(1)
	}
	srv.Stop()

	// Run tests
	code := m.Run()

	// Cleanup
	os.RemoveAll(sharedTestKeyDir)

	os.Exit(code)
}

// getSharedTestKeyPath returns the path to a pre-generated host key for tests
// that don't specifically test key generation behavior.
func getSharedTestKeyPath() string {
	return sharedTestKeyPath
}
