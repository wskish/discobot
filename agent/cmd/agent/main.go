// Package main is the entry point for the discobot-agent init process.
// This binary runs as PID 1 in the container and handles:
// - Home directory initialization and workspace cloning
// - Filesystem setup (OverlayFS for new sessions, AgentFS for existing)
// - Process reaping (zombie collection)
// - User switching from root to discobot
// - Child process management with pdeathsig
// - Signal forwarding for graceful shutdown
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed default-proxy-config.yaml
var defaultProxyConfig []byte

const (
	// Default binary to execute
	defaultAgentBinary = "/opt/discobot/bin/discobot-agent-api"

	// Default user to run as
	defaultUser = "discobot"

	// Shutdown timeout before forcing child termination
	shutdownTimeout = 10 * time.Second

	// Docker daemon startup timeout
	dockerStartupTimeout = 30 * time.Second

	// Docker socket path
	dockerSocketPath = "/var/run/docker.sock"

	// Proxy startup timeout
	proxyStartupTimeout = 10 * time.Second

	// Proxy binary path
	proxyBinary = "/opt/discobot/bin/proxy"

	// Proxy ports
	proxyPort    = 17080
	proxyAPIPort = 17081

	// Paths
	dataDir         = "/.data"
	baseHomeDir     = "/.data/discobot"           // Base home directory (copied from /home/discobot)
	workspaceDir    = "/.data/discobot/workspace" // Workspace inside home
	stagingDir      = "/.data/discobot/workspace.staging"
	agentFSDir      = "/.data/.agentfs"
	overlayFSDir    = "/.data/.overlayfs"
	mountHome       = "/home/discobot"    // Where agentfs/overlayfs mounts
	symlinkPath     = "/workspace"        // Symlink to /home/discobot/workspace
	tempMigrationFS = "/.data/.migration" // Temporary mount point for migration
)

// filesystemType represents the type of filesystem to use for session isolation
type filesystemType int

const (
	fsTypeOverlayFS filesystemType = iota
	fsTypeAgentFS
)

func (f filesystemType) String() string {
	switch f {
	case fsTypeOverlayFS:
		return "overlayfs"
	case fsTypeAgentFS:
		return "agentfs"
	default:
		return "unknown"
	}
}

// detectFilesystemType determines which filesystem to use based on existing data.
// If an agentfs database exists for the session, use agentfs for backwards compatibility.
// Otherwise, use overlayfs for new sessions.
func detectFilesystemType(sessionID string) filesystemType {
	// Check for environment variable override
	if fsOverride := os.Getenv("DISCOBOT_FILESYSTEM"); fsOverride != "" {
		switch strings.ToLower(fsOverride) {
		case "agentfs":
			fmt.Printf("discobot-agent: filesystem override: agentfs\n")
			return fsTypeAgentFS
		case "overlayfs":
			fmt.Printf("discobot-agent: filesystem override: overlayfs\n")
			return fsTypeOverlayFS
		}
	}

	// Check if migration marker exists (session has already been migrated)
	migrationMarker := filepath.Join(overlayFSDir, sessionID, ".migrated")
	if _, err := os.Stat(migrationMarker); err == nil {
		fmt.Printf("discobot-agent: session already migrated to overlayfs\n")
		return fsTypeOverlayFS
	}

	// Default: check for existing agentfs database
	dbPath := filepath.Join(agentFSDir, sessionID+".db")
	if _, err := os.Stat(dbPath); err == nil {
		return fsTypeAgentFS
	}
	return fsTypeOverlayFS
}

// migrateAgentFSToOverlayFS migrates an existing agentfs session to overlayfs.
// It mounts agentfs at a temporary location, creates overlayfs at the target,
// rsyncs the data, and marks the migration as complete.
func migrateAgentFSToOverlayFS(sessionID string, userInfo *userInfo) error {
	fmt.Printf("discobot-agent: starting migration from agentfs to overlayfs for session %s\n", sessionID)

	// Ensure migration directory exists with correct ownership
	if err := os.MkdirAll(tempMigrationFS, 0755); err != nil {
		return fmt.Errorf("failed to create migration directory: %w", err)
	}
	if err := os.Chown(tempMigrationFS, userInfo.uid, userInfo.gid); err != nil {
		return fmt.Errorf("failed to chown migration directory: %w", err)
	}

	// Step 1: Mount agentfs at temporary location
	fmt.Printf("discobot-agent: mounting agentfs at temporary location %s\n", tempMigrationFS)
	if err := mountAgentFSAtPath(sessionID, tempMigrationFS, userInfo); err != nil {
		return fmt.Errorf("failed to mount agentfs for migration: %w", err)
	}

	// Ensure cleanup on error
	defer func() {
		fmt.Printf("discobot-agent: unmounting temporary agentfs\n")
		if err := syscall.Unmount(tempMigrationFS, 0); err != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to unmount %s: %v\n", tempMigrationFS, err)
		}
	}()

	// Step 2: Setup overlayfs directories at target location
	fmt.Printf("discobot-agent: setting up overlayfs for migration\n")
	if err := setupOverlayFS(sessionID, userInfo); err != nil {
		return fmt.Errorf("failed to setup overlayfs for migration: %w", err)
	}

	// Step 3: Mount overlayfs at target
	fmt.Printf("discobot-agent: mounting overlayfs at %s\n", mountHome)
	if err := mountOverlayFS(sessionID); err != nil {
		// Clean up overlayfs directories if mount fails
		if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
		}
		return fmt.Errorf("failed to mount overlayfs for migration: %w", err)
	}

	// Ensure overlayfs cleanup on error
	defer func() {
		// Only unmount if we're returning an error (normal path will keep it mounted)
		if r := recover(); r != nil {
			fmt.Printf("discobot-agent: unmounting overlayfs due to panic\n")
			if unmountErr := syscall.Unmount(mountHome, 0); unmountErr != nil {
				fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to unmount overlayfs: %v\n", unmountErr)
			}
			panic(r)
		}
	}()

	// Step 4: Rsync from temp agentfs to target overlayfs
	fmt.Printf("discobot-agent: syncing data from agentfs to overlayfs (this may take a while)\n")
	rsyncCmd := exec.Command("rsync",
		"-a",                // archive mode (preserve permissions, timestamps, etc.)
		"--delete",          // delete files in destination that don't exist in source
		tempMigrationFS+"/", // source (trailing slash is important for rsync)
		mountHome+"/",       // destination
	)
	rsyncCmd.Stdout = os.Stdout
	rsyncCmd.Stderr = os.Stderr
	if err := rsyncCmd.Run(); err != nil {
		if unmountErr := syscall.Unmount(mountHome, 0); unmountErr != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to unmount overlayfs: %v\n", unmountErr)
		}
		if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
		}
		return fmt.Errorf("rsync failed: %w", err)
	}

	fmt.Printf("discobot-agent: data sync completed successfully\n")

	// Step 5: Unmount temporary agentfs
	fmt.Printf("discobot-agent: unmounting temporary agentfs\n")
	if err := syscall.Unmount(tempMigrationFS, 0); err != nil {
		fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to unmount temporary agentfs: %v\n", err)
		// Continue anyway - this is not fatal
	}

	// Step 6: Create migration marker
	migrationMarker := filepath.Join(overlayFSDir, sessionID, ".migrated")
	fmt.Printf("discobot-agent: creating migration marker at %s\n", migrationMarker)
	if err := os.WriteFile(migrationMarker, []byte(time.Now().Format(time.RFC3339)), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to create migration marker: %v\n", err)
		// Continue anyway - the migration is complete
	}

	fmt.Printf("discobot-agent: migration completed successfully\n")
	fmt.Printf("discobot-agent: note: agentfs database is preserved at %s for backup\n", filepath.Join(agentFSDir, sessionID+".db"))

	return nil
}

// mountAgentFSAtPath mounts agentfs at a specific path (used for migration)
func mountAgentFSAtPath(sessionID, mountPath string, u *userInfo) error {
	const maxRetries = 10

	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("discobot-agent: mounting agentfs %s at %s (attempt %d/%d)\n", sessionID, mountPath, attempt, maxRetries)

		cmd := exec.Command("agentfs", "mount", "-a", "--allow-root", sessionID, mountPath)
		cmd.Dir = dataDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{
				Uid:    uint32(u.uid),
				Gid:    uint32(u.gid),
				Groups: u.groups,
			},
		}

		if err := cmd.Run(); err != nil {
			lastErr = err
			fmt.Fprintf(os.Stderr, "discobot-agent: agentfs mount attempt %d failed: %v\n", attempt, err)
			if attempt < maxRetries {
				time.Sleep(time.Second)
			}
			continue
		}

		fmt.Printf("discobot-agent: agentfs mounted successfully at %s\n", mountPath)
		return nil
	}

	return fmt.Errorf("agentfs mount failed after %d retries: %w", maxRetries, lastErr)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "discobot-agent: %v\n", err)
		// Sleep forever to allow debugging via docker exec
		fmt.Fprintf(os.Stderr, "discobot-agent: sleeping for debug (docker exec to investigate)\n")
		sig := make(chan os.Signal, 1)
		signal.Notify(sig)
		<-sig
	}
}

func run() error {
	startupStart := time.Now()
	fmt.Printf("discobot-agent: container startup beginning at %s\n", startupStart.Format(time.RFC3339))

	// Change to root directory to avoid issues with overlayfs mounting
	// The current directory might be inside /home/discobot which will be mounted over
	if err := os.Chdir("/"); err != nil {
		return fmt.Errorf("failed to chdir to /: %w", err)
	}

	// Step 0: Fix localhost resolution to use IPv4 consistently
	// This prevents IPv4/IPv6 mismatches where servers bind to ::1 but clients connect to 127.0.0.1
	if err := fixLocalhostResolution(); err != nil {
		// Log but don't fail - this is a best-effort fix
		fmt.Printf("discobot-agent: warning: failed to fix localhost resolution: %v\n", err)
	}

	// Fix MTU for nested Docker to prevent TLS handshake timeouts
	// This works around MTU blackhole issues where large packets get dropped
	if err := fixMTUForNestedDocker(); err != nil {
		// Log but don't fail - this is a best-effort fix
		fmt.Printf("discobot-agent: warning: failed to fix MTU for nested Docker: %v\n", err)
	}

	// Determine configuration from environment
	agentBinary := envOrDefault("AGENT_BINARY", defaultAgentBinary)
	runAsUser := envOrDefault("AGENT_USER", defaultUser)
	sessionID := os.Getenv("SESSION_ID")
	workspacePath := os.Getenv("WORKSPACE_PATH")
	workspaceCommit := os.Getenv("WORKSPACE_COMMIT")

	// Validate required environment variables
	if sessionID == "" {
		return fmt.Errorf("SESSION_ID environment variable is required")
	}

	// Get user info for switching
	userInfo, err := lookupUser(runAsUser)
	if err != nil {
		return fmt.Errorf("failed to lookup user %s: %w", runAsUser, err)
	}

	// Step 0: Setup git safe.directory for all workspace paths (system-wide)
	// This must happen early so git commands work for all users
	stepStart := time.Now()
	if err := setupGitSafeDirectories(workspacePath); err != nil {
		return fmt.Errorf("git safe.directory setup failed: %w", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] git safe.directory setup completed\n", time.Since(stepStart).Seconds())

	// Step 1: Setup base home directory (copy from /home/discobot if needed)
	stepStart = time.Now()
	if err := setupBaseHome(userInfo); err != nil {
		return fmt.Errorf("base home setup failed: %w", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] base home setup completed\n", time.Since(stepStart).Seconds())

	// Step 2: Clone workspace (must complete before overlayfs mount)
	// The overlayfs captures the lower layer state at mount time, so the workspace
	// must be fully cloned into /.data/discobot/workspace before we mount overlayfs.
	stepStart = time.Now()
	if err := setupWorkspace(workspacePath, workspaceCommit, userInfo); err != nil {
		return fmt.Errorf("workspace setup failed: %w", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] workspace setup completed\n", time.Since(stepStart).Seconds())

	// Step 3: Detect filesystem type (overlayfs for new sessions, agentfs for existing)
	fsType := detectFilesystemType(sessionID)

	// Step 4: Setup and mount filesystem based on type
	stepStart = time.Now()
	switch fsType {
	case fsTypeAgentFS:
		fmt.Printf("discobot-agent: agentfs session detected, migrating to overlayfs\n")

		// Ensure agentfs directory exists with correct ownership
		if err := os.MkdirAll(agentFSDir, 0755); err != nil {
			return fmt.Errorf("failed to create agentfs directory: %w", err)
		}
		if err := os.Chown(agentFSDir, userInfo.uid, userInfo.gid); err != nil {
			return fmt.Errorf("failed to chown agentfs directory: %w", err)
		}

		// Initialize agentfs database if needed (as discobot user)
		if err := initAgentFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("agentfs init failed: %w", err)
		}

		// Perform migration from agentfs to overlayfs
		if err := migrateAgentFSToOverlayFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("migration from agentfs to overlayfs failed: %w", err)
		}

	case fsTypeOverlayFS:
		fmt.Printf("discobot-agent: using OverlayFS (new session)\n")

		// Setup overlayfs directory structure
		if err := setupOverlayFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("overlayfs setup failed: %w", err)
		}

		// Mount overlayfs over /home/discobot
		if err := mountOverlayFS(sessionID); err != nil {
			// Fallback to agentfs if overlayfs fails
			fmt.Printf("discobot-agent: overlayfs failed, falling back to agentfs: %v\n", err)
			if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
				fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
			}

			if err := os.MkdirAll(agentFSDir, 0755); err != nil {
				return fmt.Errorf("failed to create agentfs directory: %w", err)
			}
			if err := os.Chown(agentFSDir, userInfo.uid, userInfo.gid); err != nil {
				return fmt.Errorf("failed to chown agentfs directory: %w", err)
			}
			if err := initAgentFS(sessionID, userInfo); err != nil {
				return fmt.Errorf("agentfs init failed: %w", err)
			}
			if err := mountAgentFS(sessionID, userInfo); err != nil {
				return fmt.Errorf("agentfs mount (fallback) failed: %w", err)
			}
		}
	}
	fmt.Printf("discobot-agent: [%.3fs] filesystem setup completed (%s)\n", time.Since(stepStart).Seconds(), fsType)

	// Step 4.5: Mount cache directories on top of the overlay
	stepStart = time.Now()
	if err := mountCacheDirectories(); err != nil {
		// Log but don't fail - cache mounting is optional
		fmt.Printf("discobot-agent: Cache mount failed: %v\n", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] cache directories mounted\n", time.Since(stepStart).Seconds())

	// Step 5: Create /workspace symlink to /home/discobot/workspace
	stepStart = time.Now()
	if err := createWorkspaceSymlink(); err != nil {
		return fmt.Errorf("symlink creation failed: %w", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] workspace symlink created\n", time.Since(stepStart).Seconds())

	// Step 6: Setup proxy configuration (uses embedded defaults only for security)
	stepStart = time.Now()
	if err := setupProxyConfig(userInfo); err != nil {
		// Log but don't fail - proxy config is optional
		fmt.Printf("discobot-agent: Proxy config setup failed: %v\n", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] proxy config setup completed\n", time.Since(stepStart).Seconds())

	// Step 7: Generate CA certificate and install in system trust store
	stepStart = time.Now()
	if err := setupProxyCertificate(); err != nil {
		// Log but don't fail - proxy cert is optional
		fmt.Printf("discobot-agent: Proxy certificate setup failed: %v\n", err)
	}
	fmt.Printf("discobot-agent: [%.3fs] CA certificate setup completed\n", time.Since(stepStart).Seconds())

	// Step 8: Start proxy daemon with embedded defaults
	stepStart = time.Now()
	proxyCmd, err := startProxyDaemon(userInfo)
	proxyEnabled := (err == nil && proxyCmd != nil)
	if err != nil {
		// Log but don't fail - Proxy is optional
		fmt.Printf("discobot-agent: Proxy daemon not started: %v\n", err)
	} else {
		fmt.Printf("discobot-agent: [%.3fs] proxy daemon started\n", time.Since(stepStart).Seconds())
	}

	// Step 9: Start Docker daemon if available (after proxy so Docker can use it)
	stepStart = time.Now()
	dockerCmd, err := startDockerDaemon(proxyEnabled)
	if err != nil {
		// Log but don't fail - Docker is optional
		fmt.Printf("discobot-agent: Docker daemon not started: %v\n", err)
	} else {
		fmt.Printf("discobot-agent: [%.3fs] Docker daemon started\n", time.Since(stepStart).Seconds())
	}

	// Step 10: Run the agent API
	fmt.Printf("discobot-agent: [%.3fs] total startup time\n", time.Since(startupStart).Seconds())
	fmt.Printf("discobot-agent: starting agent API\n")
	return runAgent(agentBinary, userInfo, dockerCmd, proxyCmd)
}

// fixLocalhostResolution modifies /etc/hosts to ensure localhost resolves to IPv4 (127.0.0.1).
// This fixes IPv4/IPv6 mismatches where Node.js servers bind to ::1 (IPv6) by default when
// using "localhost", but HTTP clients (like Bun's fetch) resolve localhost to 127.0.0.1 (IPv4).
// The fix removes ::1 from the localhost line to force consistent IPv4 resolution.
func fixLocalhostResolution() error {
	const hostsPath = "/etc/hosts"

	// Read current hosts file
	data, err := os.ReadFile(hostsPath)
	if err != nil {
		return fmt.Errorf("failed to read %s: %w", hostsPath, err)
	}

	lines := strings.Split(string(data), "\n")
	var newLines []string
	modified := false
	hasIPv4Localhost := false

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Skip empty lines and comments
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			newLines = append(newLines, line)
			continue
		}

		// Parse the line: first field is IP, rest are hostnames
		fields := strings.Fields(trimmed)
		if len(fields) < 2 {
			newLines = append(newLines, line)
			continue
		}

		ip := fields[0]
		hostnames := fields[1:]

		// Check if this line has "localhost" as a hostname
		hasLocalhost := false
		for _, h := range hostnames {
			if h == "localhost" {
				hasLocalhost = true
				break
			}
		}

		if !hasLocalhost {
			// Line doesn't affect localhost resolution, keep it
			newLines = append(newLines, line)
			continue
		}

		// This line has localhost
		switch ip {
		case "127.0.0.1":
			// Keep IPv4 localhost line
			newLines = append(newLines, line)
			hasIPv4Localhost = true
		case "::1":
			// Remove localhost from IPv6 line, but keep other hostnames
			var remainingHostnames []string
			for _, h := range hostnames {
				if h != "localhost" {
					remainingHostnames = append(remainingHostnames, h)
				}
			}

			if len(remainingHostnames) > 0 {
				// Keep the line with remaining hostnames (e.g., ip6-localhost)
				newLines = append(newLines, ip+"\t"+strings.Join(remainingHostnames, " "))
			}
			// If no remaining hostnames, the line is dropped entirely
			modified = true
			fmt.Printf("discobot-agent: removed 'localhost' from ::1 line in /etc/hosts\n")
		default:
			// Some other IP with localhost, keep it
			newLines = append(newLines, line)
		}
	}

	// Ensure we have an IPv4 localhost entry
	if !hasIPv4Localhost {
		newLines = append([]string{"127.0.0.1\tlocalhost"}, newLines...)
		modified = true
		fmt.Printf("discobot-agent: added '127.0.0.1 localhost' to /etc/hosts\n")
	}

	if !modified {
		fmt.Printf("discobot-agent: /etc/hosts already configured correctly for localhost\n")
		return nil
	}

	// Write back the modified hosts file
	newContent := strings.Join(newLines, "\n")
	if err := os.WriteFile(hostsPath, []byte(newContent), 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", hostsPath, err)
	}

	fmt.Printf("discobot-agent: /etc/hosts updated to ensure localhost resolves to 127.0.0.1\n")
	return nil
}

// fixMTUForNestedDocker configures TCP settings to work around MTU blackhole issues
// in nested Docker environments where path MTU discovery fails.
//
// The fix works by:
// 1. Disabling PMTU discovery (which relies on ICMP that gets blocked in nested Docker)
// 2. Enabling TCP MTU probing (ICMP-free mechanism that auto-detects working packet size)
//
// With these settings, TCP automatically discovers the optimal MTU without needing to
// reduce the interface MTU, allowing maximum throughput while avoiding packet drops.
func fixMTUForNestedDocker() error {
	// Disable path MTU discovery to prevent relying on ICMP (which may be blocked in nested Docker)
	// When PMTUD fails, packets are sent at full MTU and silently dropped if too large
	cmd := exec.Command("sysctl", "-w", "net.ipv4.ip_no_pmtu_disc=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to disable PMTU discovery: %w (output: %s)", err, output)
	}

	// Enable TCP MTU probing as a fallback mechanism
	// This allows TCP to discover working MTU by detecting dropped packets and trying smaller sizes
	// This works without ICMP and is essential for nested Docker where ICMP is unreliable
	cmd = exec.Command("sysctl", "-w", "net.ipv4.tcp_mtu_probing=1")
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to enable TCP MTU probing: %w (output: %s)", err, output)
	}

	fmt.Printf("discobot-agent: configured TCP MTU probing for nested Docker (PMTUD disabled, TCP probing enabled)\n")
	return nil
}

// setupGitSafeDirectories configures git safe.directory for all workspace paths.
// Uses --system to write to /etc/gitconfig so all users (including discobot) can see it.
func setupGitSafeDirectories(workspacePath string) error {
	// Paths that need to be marked as safe for git operations
	dirs := []string{
		"/.workspace",                         // Source workspace mount point
		"/.workspace/.git",                    // Git directory (some operations check .git specifically)
		workspaceDir,                          // /.data/discobot/workspace
		stagingDir,                            // /.data/discobot/workspace.staging (used during clone)
		filepath.Join(mountHome, "workspace"), // /home/discobot/workspace (after agentfs mount)
		symlinkPath,                           // /workspace symlink
	}

	// Add the specific workspacePath if provided and different from /.workspace
	if workspacePath != "" && workspacePath != "/.workspace" {
		dirs = append([]string{workspacePath}, dirs...)
	}

	fmt.Printf("discobot-agent: configuring git safe.directory for workspace paths\n")
	for _, dir := range dirs {
		cmd := exec.Command("git", "config", "--system", "--add", "safe.directory", dir)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			// Log but don't fail - some paths may not exist yet
			fmt.Printf("discobot-agent: warning: git config safe.directory %s: %v\n", dir, err)
		}
	}

	return nil
}

// setupBaseHome copies /home/discobot to /.data/discobot if it doesn't exist,
// or syncs new files if it already exists
func setupBaseHome(u *userInfo) error {
	// Check if base home already exists
	if _, err := os.Stat(baseHomeDir); err == nil {
		fmt.Printf("discobot-agent: base home already exists at %s, syncing new files\n", baseHomeDir)
		// Sync any new files from /home/discobot to /.data/discobot
		// This ensures new files added to the container image get propagated
		if err := syncNewFiles(mountHome, baseHomeDir, u); err != nil {
			return fmt.Errorf("failed to sync new files: %w", err)
		}
		return nil
	}

	fmt.Printf("discobot-agent: copying /home/discobot to %s\n", baseHomeDir)

	// Create parent directory
	if err := os.MkdirAll(filepath.Dir(baseHomeDir), 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}

	// Copy /home/discobot to /.data/discobot recursively with permissions
	if err := copyDir(mountHome, baseHomeDir); err != nil {
		return fmt.Errorf("failed to copy home directory: %w", err)
	}

	// Ensure ownership is correct
	if err := chownRecursive(baseHomeDir, u.uid, u.gid); err != nil {
		return fmt.Errorf("failed to chown base home: %w", err)
	}

	fmt.Printf("discobot-agent: base home created successfully\n")
	return nil
}

// syncNewFiles copies files from src to dst that don't exist in dst.
// It does not overwrite existing files to preserve user modifications.
func syncNewFiles(src, dst string, u *userInfo) error {
	return filepath.Walk(src, func(srcPath string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Calculate relative path and destination path
		relPath, err := filepath.Rel(src, srcPath)
		if err != nil {
			return err
		}
		dstPath := filepath.Join(dst, relPath)

		// Check if destination already exists
		_, dstErr := os.Lstat(dstPath)
		if dstErr == nil {
			// Destination exists, skip (don't overwrite)
			return nil
		}
		if !os.IsNotExist(dstErr) {
			// Some other error
			return dstErr
		}

		// Destination doesn't exist, copy it
		if info.IsDir() {
			fmt.Printf("discobot-agent: syncing new directory %s\n", relPath)
			if err := os.MkdirAll(dstPath, info.Mode().Perm()); err != nil {
				return err
			}
			if err := os.Chown(dstPath, u.uid, u.gid); err != nil {
				return err
			}
		} else if info.Mode()&os.ModeSymlink != 0 {
			// Handle symlinks
			link, err := os.Readlink(srcPath)
			if err != nil {
				return err
			}
			fmt.Printf("discobot-agent: syncing new symlink %s\n", relPath)
			if err := os.Symlink(link, dstPath); err != nil {
				return err
			}
			if err := os.Lchown(dstPath, u.uid, u.gid); err != nil {
				return err
			}
		} else if info.Mode().IsRegular() {
			fmt.Printf("discobot-agent: syncing new file %s\n", relPath)
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
			if err := os.Chown(dstPath, u.uid, u.gid); err != nil {
				return err
			}
		}

		return nil
	})
}

// copyDir recursively copies a directory preserving permissions
func copyDir(src, dst string) error {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return err
	}

	// Create destination directory with same permissions
	if err := os.MkdirAll(dst, srcInfo.Mode().Perm()); err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyDir(srcPath, dstPath); err != nil {
				return err
			}
		} else if entry.Type()&os.ModeSymlink != 0 {
			// Handle symlinks
			link, err := os.Readlink(srcPath)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, dstPath); err != nil {
				return err
			}
		} else {
			// Copy regular file
			if err := copyFile(srcPath, dstPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// copyFile copies a single file preserving permissions
func copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := srcFile.Close(); closeErr != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to close source file %s: %v\n", src, closeErr)
		}
	}()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode().Perm())
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := dstFile.Close(); closeErr != nil {
			fmt.Fprintf(os.Stderr, "discobot-agent: warning: failed to close destination file %s: %v\n", dst, closeErr)
		}
	}()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// setupWorkspace clones the workspace if it doesn't exist.
func setupWorkspace(workspacePath, workspaceCommit string, u *userInfo) error {
	// If workspace already exists, nothing to do
	if _, err := os.Stat(workspaceDir); err == nil {
		fmt.Printf("discobot-agent: workspace already exists at %s\n", workspaceDir)
		return nil
	}

	// If no workspace path specified, create empty workspace owned by user
	if workspacePath == "" {
		fmt.Println("discobot-agent: no WORKSPACE_PATH specified, creating empty workspace")
		if err := os.MkdirAll(workspaceDir, 0755); err != nil {
			return fmt.Errorf("failed to create workspace directory: %w", err)
		}
		if err := os.Chown(workspaceDir, u.uid, u.gid); err != nil {
			return fmt.Errorf("failed to chown workspace directory: %w", err)
		}
		return nil
	}

	fmt.Printf("discobot-agent: cloning workspace from %s\n", workspacePath)

	// Clean up any existing staging directory
	if err := os.RemoveAll(stagingDir); err != nil {
		return fmt.Errorf("failed to remove staging directory: %w", err)
	}

	// Note: git safe.directory is configured system-wide in setupGitSafeDirectories()

	// Clone to staging directory first
	cloneArgs := []string{"clone", "--single-branch", workspacePath, stagingDir}

	cmd := exec.Command("git", cloneArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	fmt.Printf("discobot-agent: running: git %v\n", cloneArgs)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git clone failed: %w", err)
	}

	// If specific commit requested, create a branch at that commit to avoid detached HEAD
	if workspaceCommit != "" {
		// Create a temporary branch at the target commit
		branchName := "discobot-session"
		cmd = exec.Command("git", "-C", stagingDir, "checkout", "-B", branchName, workspaceCommit)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		fmt.Printf("discobot-agent: creating branch %s at commit %s\n", branchName, workspaceCommit)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("git checkout -B %s %s failed: %w", branchName, workspaceCommit, err)
		}
	}

	// Change ownership of all files to the target user
	fmt.Printf("discobot-agent: changing workspace ownership to %s\n", u.username)
	if err := chownRecursive(stagingDir, u.uid, u.gid); err != nil {
		return fmt.Errorf("failed to chown workspace: %w", err)
	}

	// Atomically move staging to final location
	if err := os.Rename(stagingDir, workspaceDir); err != nil {
		return fmt.Errorf("failed to move staging to workspace: %w", err)
	}

	fmt.Printf("discobot-agent: workspace cloned successfully\n")
	return nil
}

// chownRecursive recursively changes ownership of a directory and all its contents
func chownRecursive(path string, uid, gid int) error {
	return filepath.Walk(path, func(name string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		return os.Lchown(name, uid, gid)
	})
}

// initAgentFS initializes the agentfs database if it doesn't exist
func initAgentFS(sessionID string, u *userInfo) error {
	dbPath := filepath.Join(agentFSDir, sessionID+".db")

	// Check if database already exists
	if _, err := os.Stat(dbPath); err == nil {
		fmt.Printf("discobot-agent: agentfs database already exists at %s\n", dbPath)
		return nil
	}

	fmt.Printf("discobot-agent: initializing agentfs for session %s\n", sessionID)

	cmd := exec.Command("agentfs", "init", "--base", baseHomeDir, sessionID)
	cmd.Dir = dataDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid:    uint32(u.uid),
			Gid:    uint32(u.gid),
			Groups: u.groups,
		},
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("agentfs init failed: %w", err)
	}

	fmt.Printf("discobot-agent: agentfs initialized successfully\n")
	return nil
}

// mountAgentFS mounts the agentfs database over /home/discobot
// It retries up to 10 times, then attempts foreground mode for debug output
func mountAgentFS(sessionID string, u *userInfo) error {
	const maxRetries = 10

	// Try mounting in daemon mode (with -a flag) up to maxRetries times
	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("discobot-agent: mounting agentfs %s at %s (attempt %d/%d)\n", sessionID, mountHome, attempt, maxRetries)

		// -a: auto-unmount on exit (daemon mode)
		// --allow-root: allow root to access the FUSE mount
		cmd := exec.Command("agentfs", "mount", "-a", "--allow-root", sessionID, mountHome)
		cmd.Dir = dataDir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Credential: &syscall.Credential{
				Uid:    uint32(u.uid),
				Gid:    uint32(u.gid),
				Groups: u.groups,
			},
		}

		if err := cmd.Run(); err != nil {
			lastErr = err
			fmt.Fprintf(os.Stderr, "discobot-agent: agentfs mount attempt %d failed: %v\n", attempt, err)
			if attempt < maxRetries {
				time.Sleep(time.Second) // Brief delay before retry
			}
			continue
		}

		fmt.Printf("discobot-agent: agentfs mounted successfully\n")
		return nil
	}

	// All retries failed - try foreground mode to capture debug output
	fmt.Fprintf(os.Stderr, "discobot-agent: ERROR: agentfs mount failed %d times\n", maxRetries)
	fmt.Fprintf(os.Stderr, "discobot-agent: attempting foreground mount to capture debug logs...\n")

	// Run with -f flag for foreground mode to capture debug output
	cmd := exec.Command("agentfs", "mount", "-a", "-f", "--allow-root", sessionID, mountHome)
	cmd.Dir = dataDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid:    uint32(u.uid),
			Gid:    uint32(u.gid),
			Groups: u.groups,
		},
	}

	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "discobot-agent: foreground mount also failed: %v\n", err)
		fmt.Fprintf(os.Stderr, "discobot-agent: sleeping forever for debug (docker exec to investigate)\n")
		sig := make(chan os.Signal, 1)
		signal.Notify(sig)
		<-sig
		// Won't reach here, but return for completeness
		return fmt.Errorf("agentfs mount failed after %d retries and foreground attempt: %w", maxRetries, lastErr)
	}

	// Foreground mount succeeded (unexpected but handle it)
	fmt.Printf("discobot-agent: agentfs foreground mount succeeded\n")
	return nil
}

// setupOverlayFS creates the directory structure for overlayfs
func setupOverlayFS(sessionID string, u *userInfo) error {
	sessionDir := filepath.Join(overlayFSDir, sessionID)
	upperDir := filepath.Join(sessionDir, "upper")
	workDir := filepath.Join(sessionDir, "work")

	fmt.Printf("discobot-agent: setting up overlayfs directories at %s\n", sessionDir)

	// Create all directories
	for _, dir := range []string{overlayFSDir, sessionDir, upperDir, workDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}

	// Set ownership on session-specific directories
	for _, dir := range []string{sessionDir, upperDir, workDir} {
		if err := os.Chown(dir, u.uid, u.gid); err != nil {
			return fmt.Errorf("failed to chown directory %s: %w", dir, err)
		}
	}

	fmt.Printf("discobot-agent: overlayfs directories created successfully\n")
	return nil
}

// mountOverlayFS mounts the overlayfs filesystem over /home/discobot
func mountOverlayFS(sessionID string) error {
	sessionDir := filepath.Join(overlayFSDir, sessionID)
	upperDir := filepath.Join(sessionDir, "upper")
	workDir := filepath.Join(sessionDir, "work")

	// Construct mount options:
	// lowerdir = read-only base layer
	// upperdir = writable layer for changes
	// workdir = scratch space for overlayfs internal use
	opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", baseHomeDir, upperDir, workDir)

	fmt.Printf("discobot-agent: mounting overlayfs at %s\n", mountHome)
	fmt.Printf("discobot-agent: overlayfs options: %s\n", opts)

	if err := syscall.Mount("overlay", mountHome, "overlay", 0, opts); err != nil {
		return fmt.Errorf("overlayfs mount failed: %w", err)
	}

	fmt.Printf("discobot-agent: overlayfs mounted successfully\n")
	return nil
}

// createWorkspaceSymlink creates /workspace -> /home/discobot/workspace symlink
func createWorkspaceSymlink() error {
	target := filepath.Join(mountHome, "workspace")

	// Remove existing symlink or file if present
	if _, err := os.Lstat(symlinkPath); err == nil {
		if err := os.Remove(symlinkPath); err != nil {
			return fmt.Errorf("failed to remove existing %s: %w", symlinkPath, err)
		}
	}

	fmt.Printf("discobot-agent: creating symlink %s -> %s\n", symlinkPath, target)
	if err := os.Symlink(target, symlinkPath); err != nil {
		return fmt.Errorf("failed to create symlink: %w", err)
	}

	return nil
}

// startDockerDaemon starts the Docker daemon if dockerd is available on PATH.
// Returns the running command (for cleanup) or nil if Docker is not available.
// getProxyEnvVars returns the proxy environment variables if proxy is enabled.
func getProxyEnvVars() []string {
	proxyURL := fmt.Sprintf("http://localhost:%d", proxyPort)
	noProxy := "localhost,127.0.0.1,::1"
	caCertPath := filepath.Join(dataDir, "proxy", "certs", "ca.crt")
	return []string{
		"HTTP_PROXY=" + proxyURL,
		"HTTPS_PROXY=" + proxyURL,
		"http_proxy=" + proxyURL,
		"https_proxy=" + proxyURL,
		"ALL_PROXY=" + proxyURL,
		"all_proxy=" + proxyURL,
		"NO_PROXY=" + noProxy,
		"no_proxy=" + noProxy,
		"NODE_EXTRA_CA_CERTS=" + caCertPath,
	}
}

// setProxyInProfile writes proxy environment variables to /etc/profile.d/discobot-proxy.sh
// so that login shells automatically inherit the proxy configuration.
func setProxyInProfile() error {
	profileDir := "/etc/profile.d"

	// Check if /etc/profile.d exists
	if _, err := os.Stat(profileDir); os.IsNotExist(err) {
		// If /etc/profile.d doesn't exist, try /etc/profile directly
		return setProxyInEtcProfile()
	}

	// Write proxy settings to /etc/profile.d/discobot-proxy.sh
	profilePath := filepath.Join(profileDir, "discobot-proxy.sh")
	proxyURL := fmt.Sprintf("http://localhost:%d", proxyPort)
	caCertPath := filepath.Join(dataDir, "proxy", "certs", "ca.crt")

	content := fmt.Sprintf(`# Discobot Proxy Configuration
# Automatically generated by discobot-agent
# This file sets proxy environment variables for all login shells

export HTTP_PROXY=%s
export HTTPS_PROXY=%s
export http_proxy=%s
export https_proxy=%s
export ALL_PROXY=%s
export all_proxy=%s

# Bypass proxy for localhost
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1

# Node.js: Trust the proxy's CA certificate
export NODE_EXTRA_CA_CERTS=%s
`, proxyURL, proxyURL, proxyURL, proxyURL, proxyURL, proxyURL, caCertPath)

	if err := os.WriteFile(profilePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", profilePath, err)
	}

	fmt.Printf("discobot-agent: proxy settings written to %s\n", profilePath)
	return nil
}

// setProxyInEtcProfile appends proxy settings to /etc/profile if /etc/profile.d doesn't exist.
func setProxyInEtcProfile() error {
	profilePath := "/etc/profile"

	// Check if /etc/profile exists
	if _, err := os.Stat(profilePath); os.IsNotExist(err) {
		return fmt.Errorf("neither /etc/profile.d nor /etc/profile exists")
	}

	proxyURL := fmt.Sprintf("http://localhost:%d", proxyPort)
	caCertPath := filepath.Join(dataDir, "proxy", "certs", "ca.crt")

	content := fmt.Sprintf(`

# Discobot Proxy Configuration (added by discobot-agent)
export HTTP_PROXY=%s
export HTTPS_PROXY=%s
export http_proxy=%s
export https_proxy=%s
export ALL_PROXY=%s
export all_proxy=%s
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS=%s
`, proxyURL, proxyURL, proxyURL, proxyURL, proxyURL, proxyURL, caCertPath)

	// Append to /etc/profile
	f, err := os.OpenFile(profilePath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("failed to open %s: %w", profilePath, err)
	}
	defer func() { _ = f.Close() }()

	if _, err := f.WriteString(content); err != nil {
		return fmt.Errorf("failed to write to %s: %w", profilePath, err)
	}

	fmt.Printf("discobot-agent: proxy settings appended to %s\n", profilePath)
	return nil
}

func startDockerDaemon(proxyEnabled bool) (*exec.Cmd, error) {
	// Check if dockerd is on PATH
	dockerdPath, err := exec.LookPath("dockerd")
	if err != nil {
		return nil, fmt.Errorf("dockerd not found on PATH: %w", err)
	}

	fmt.Printf("discobot-agent: found dockerd at %s, starting Docker daemon...\n", dockerdPath)

	// Ensure /var/run exists for the socket
	if err := os.MkdirAll("/var/run", 0755); err != nil {
		return nil, fmt.Errorf("failed to create /var/run: %w", err)
	}

	// Create Docker daemon configuration with MTU based on current interface MTU
	// Docker containers need a lower MTU than the host interface to account for
	// additional overhead (VXLAN, overlay networks, etc.)
	if err := os.MkdirAll("/etc/docker", 0755); err != nil {
		return nil, fmt.Errorf("failed to create /etc/docker: %w", err)
	}

	// Read current MTU from eth0 to calculate appropriate Docker MTU
	mtuBytes, err := os.ReadFile("/sys/class/net/eth0/mtu")
	if err != nil {
		return nil, fmt.Errorf("failed to read current MTU: %w", err)
	}
	currentMTU, err := strconv.Atoi(strings.TrimSpace(string(mtuBytes)))
	if err != nil {
		return nil, fmt.Errorf("failed to parse MTU: %w", err)
	}

	// Subtract overhead for Docker networking (typically 50-100 bytes)
	// We use 100 to be conservative and ensure packets don't fragment
	dockerMTU := currentMTU - 100
	if dockerMTU < 1200 {
		dockerMTU = 1200 // Ensure minimum viable MTU
	}

	daemonConfig := map[string]interface{}{
		"mtu": dockerMTU,
	}
	configBytes, err := json.MarshalIndent(daemonConfig, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("failed to marshal daemon config: %w", err)
	}
	if err := os.WriteFile("/etc/docker/daemon.json", configBytes, 0644); err != nil {
		return nil, fmt.Errorf("failed to write daemon.json: %w", err)
	}
	fmt.Printf("discobot-agent: configured Docker daemon with MTU=%d (interface MTU: %d, overhead: 100)\n", dockerMTU, currentMTU)

	// Start dockerd in the background
	// Use --storage-driver=overlay2 which works well in containers
	// Use /.data/docker for persistent storage
	dockerDataDir := filepath.Join(dataDir, "docker")
	if err := os.MkdirAll(dockerDataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create docker data dir: %w", err)
	}

	cmd := exec.Command(dockerdPath,
		"--data-root", dockerDataDir,
		"--storage-driver", "overlay2",
		"--host", "unix://"+dockerSocketPath,
		"--log-level", "error",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// Set proxy environment variables for Docker daemon if proxy is enabled
	// This allows Docker to use the proxy for image pulls
	if proxyEnabled {
		cmd.Env = append(os.Environ(), getProxyEnvVars()...)
		fmt.Printf("discobot-agent: Docker daemon configured to use proxy at http://localhost:%d\n", proxyPort)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start dockerd: %w", err)
	}

	fmt.Printf("discobot-agent: dockerd started (pid=%d), waiting for socket...\n", cmd.Process.Pid)

	// Wait for the Docker socket to become available
	if err := waitForDockerSocket(); err != nil {
		// Kill dockerd if socket never appeared
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("docker socket did not become available: %w", err)
	}

	// Make the socket world-readable and writable
	if err := os.Chmod(dockerSocketPath, 0666); err != nil {
		fmt.Printf("discobot-agent: warning: failed to chmod docker socket: %v\n", err)
	} else {
		fmt.Printf("discobot-agent: docker socket permissions set to 0666\n")
	}

	fmt.Printf("discobot-agent: Docker daemon ready\n")
	return cmd, nil
}

// waitForDockerSocket waits for the Docker socket to become available.
func waitForDockerSocket() error {
	deadline := time.Now().Add(dockerStartupTimeout)

	for time.Now().Before(deadline) {
		// Check if socket exists
		info, err := os.Stat(dockerSocketPath)
		if err == nil && info.Mode()&os.ModeSocket != 0 {
			// Socket exists, try to connect to verify it's ready
			conn, err := net.DialTimeout("unix", dockerSocketPath, 2*time.Second)
			if err == nil {
				_ = conn.Close()
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("timeout waiting for docker socket at %s", dockerSocketPath)
}

// startProxyDaemon starts the HTTP proxy if the binary is available.
// Returns the running command (for cleanup) or nil if proxy is not available.
func startProxyDaemon(userInfo *userInfo) (*exec.Cmd, error) {
	// Check if proxy binary exists
	if _, err := os.Stat(proxyBinary); err != nil {
		return nil, fmt.Errorf("proxy binary not found at %s: %w", proxyBinary, err)
	}

	fmt.Printf("discobot-agent: found proxy at %s, starting HTTP proxy...\n", proxyBinary)

	// Create proxy directory (session-scoped at /.data/proxy)
	proxyDir := filepath.Join(dataDir, "proxy")
	if err := os.MkdirAll(proxyDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create proxy dir: %w", err)
	}
	if err := os.Chown(proxyDir, userInfo.uid, userInfo.gid); err != nil {
		fmt.Printf("discobot-agent: warning: failed to chown proxy dir: %v\n", err)
	}

	// Create certs subdirectory (session-scoped)
	certsDir := filepath.Join(proxyDir, "certs")
	if err := os.MkdirAll(certsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create proxy certs dir: %w", err)
	}
	if err := os.Chown(certsDir, userInfo.uid, userInfo.gid); err != nil {
		fmt.Printf("discobot-agent: warning: failed to chown proxy certs dir: %v\n", err)
	}

	// Create cache directory (project-scoped at /.data/cache/proxy)
	cacheDir := filepath.Join(dataDir, "cache", "proxy")
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create proxy cache dir: %w", err)
	}
	if err := os.Chown(cacheDir, userInfo.uid, userInfo.gid); err != nil {
		fmt.Printf("discobot-agent: warning: failed to chown proxy cache dir: %v\n", err)
	}

	// Start proxy with config file (config is session-scoped)
	configPath := filepath.Join(proxyDir, "config.yaml")
	cmd := exec.Command(proxyBinary, "-config", configPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start proxy: %w", err)
	}

	fmt.Printf("discobot-agent: proxy started (pid=%d), waiting for health check...\n", cmd.Process.Pid)

	// Wait for proxy to be ready
	if err := waitForProxyReady(); err != nil {
		// Kill proxy if it never became ready
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("proxy did not become ready: %w", err)
	}

	fmt.Printf("discobot-agent: HTTP proxy ready on port %d\n", proxyPort)

	// Set proxy environment in /etc/profile.d for login shells
	if err := setProxyInProfile(); err != nil {
		// Log but don't fail - this is optional
		fmt.Printf("discobot-agent: warning: failed to set proxy in /etc/profile.d: %v\n", err)
	}

	return cmd, nil
}

// waitForProxyReady waits for the proxy health endpoint to respond.
func waitForProxyReady() error {
	deadline := time.Now().Add(proxyStartupTimeout)
	healthURL := fmt.Sprintf("http://localhost:%d/health", proxyAPIPort)

	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", proxyAPIPort), 2*time.Second)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("timeout waiting for proxy health check at %s", healthURL)
}

// setupProxyCertificate generates a CA certificate for the proxy and installs it in the system trust store.
// The certificate is stored in /.data/proxy/certs/ (session-scoped) and will be used by the proxy for HTTPS MITM.
func setupProxyCertificate() error {
	certDir := filepath.Join(dataDir, "proxy", "certs")
	certPath := filepath.Join(certDir, "ca.crt")
	keyPath := filepath.Join(certDir, "ca.key")

	// Ensure cert directory exists
	if err := os.MkdirAll(certDir, 0755); err != nil {
		return fmt.Errorf("failed to create cert dir: %w", err)
	}

	// Check if certificate already exists
	if _, err := os.Stat(certPath); err == nil {
		fmt.Printf("discobot-agent: proxy CA certificate already exists at %s\n", certPath)
		// Certificate exists, ensure it's installed in system trust store
		return installCertificateInSystemTrust(certPath)
	}

	fmt.Printf("discobot-agent: generating proxy CA certificate...\n")

	// Generate CA certificate using the proxy's cert package
	// We'll call the proxy binary with a special flag to generate the cert
	// Since we don't want to import the proxy code, we'll generate it inline
	if err := generateCACertificate(certPath, keyPath); err != nil {
		return fmt.Errorf("failed to generate CA certificate: %w", err)
	}

	fmt.Printf("discobot-agent: proxy CA certificate generated at %s\n", certPath)

	// Install certificate in system trust store
	return installCertificateInSystemTrust(certPath)
}

// generateCACertificate creates a CA certificate and private key using Go crypto libraries.
// Includes localhost in SANs for proper HTTPS interception.
func generateCACertificate(certPath, keyPath string) error {
	// Generate RSA private key (2048-bit)
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("generate RSA key: %w", err)
	}

	// Generate serial number
	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return fmt.Errorf("generate serial number: %w", err)
	}

	// Create certificate template
	// Include localhost in SANs for proper HTTPS interception
	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject: pkix.Name{
			Organization: []string{"Discobot Proxy"},
			CommonName:   "Discobot Proxy CA",
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            0,
		MaxPathLenZero:        true,
		// Add SANs for localhost (both IPv4 and IPv6)
		DNSNames:    []string{"localhost"},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}

	// Create self-signed certificate
	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privateKey.PublicKey, privateKey)
	if err != nil {
		return fmt.Errorf("create certificate: %w", err)
	}

	// Save certificate (PEM format)
	certFile, err := os.OpenFile(certPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("create cert file: %w", err)
	}
	defer func() { _ = certFile.Close() }()

	if err := pem.Encode(certFile, &pem.Block{Type: "CERTIFICATE", Bytes: certDER}); err != nil {
		return fmt.Errorf("encode certificate: %w", err)
	}

	// Save private key (PEM format)
	keyFile, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("create key file: %w", err)
	}
	defer func() { _ = keyFile.Close() }()

	keyDER := x509.MarshalPKCS1PrivateKey(privateKey)
	if err := pem.Encode(keyFile, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: keyDER}); err != nil {
		return fmt.Errorf("encode private key: %w", err)
	}

	return nil
}

// installCertificateInSystemTrust installs the CA certificate in the system trust store.
// Supports Debian/Ubuntu, Fedora/RHEL, and Alpine Linux.
func installCertificateInSystemTrust(certPath string) error {
	fmt.Printf("discobot-agent: installing proxy CA certificate in system trust store...\n")

	// Detect which certificate update method to use
	// Try in order: update-ca-certificates (Debian/Alpine), update-ca-trust (Fedora)

	// Debian/Ubuntu/Alpine: update-ca-certificates
	if _, err := exec.LookPath("update-ca-certificates"); err == nil {
		return installCertDebianStyle(certPath)
	}

	// Fedora/RHEL/CentOS: update-ca-trust
	if _, err := exec.LookPath("update-ca-trust"); err == nil {
		return installCertFedoraStyle(certPath)
	}

	// If no cert update tool found, warn but don't fail
	fmt.Printf("discobot-agent: warning: no certificate update tool found (update-ca-certificates or update-ca-trust)\n")
	fmt.Printf("discobot-agent: warning: proxy CA certificate not installed in system trust store\n")
	fmt.Printf("discobot-agent: warning: HTTPS interception may not work for some clients\n")
	return nil
}

// installCertDebianStyle installs the certificate on Debian/Ubuntu/Alpine systems.
func installCertDebianStyle(certPath string) error {
	// Copy certificate to /usr/local/share/ca-certificates/
	destDir := "/usr/local/share/ca-certificates"
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("failed to create ca-certificates dir: %w", err)
	}

	destPath := filepath.Join(destDir, "discobot-proxy-ca.crt")

	// Read source certificate
	data, err := os.ReadFile(certPath)
	if err != nil {
		return fmt.Errorf("failed to read certificate: %w", err)
	}

	// Write to destination
	if err := os.WriteFile(destPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write certificate to %s: %w", destPath, err)
	}

	// Run update-ca-certificates
	cmd := exec.Command("update-ca-certificates")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to run update-ca-certificates: %w", err)
	}

	fmt.Printf("discobot-agent: proxy CA certificate installed in system trust store (Debian/Ubuntu/Alpine)\n")
	return nil
}

// installCertFedoraStyle installs the certificate on Fedora/RHEL/CentOS systems.
func installCertFedoraStyle(certPath string) error {
	// Copy certificate to /etc/pki/ca-trust/source/anchors/
	destDir := "/etc/pki/ca-trust/source/anchors"
	if err := os.MkdirAll(destDir, 0755); err != nil {
		return fmt.Errorf("failed to create ca-trust dir: %w", err)
	}

	destPath := filepath.Join(destDir, "discobot-proxy-ca.crt")

	// Read source certificate
	data, err := os.ReadFile(certPath)
	if err != nil {
		return fmt.Errorf("failed to read certificate: %w", err)
	}

	// Write to destination
	if err := os.WriteFile(destPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write certificate to %s: %w", destPath, err)
	}

	// Run update-ca-trust
	cmd := exec.Command("update-ca-trust", "extract")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to run update-ca-trust: %w", err)
	}

	fmt.Printf("discobot-agent: proxy CA certificate installed in system trust store (Fedora/RHEL)\n")
	return nil
}

// setupProxyConfig configures the proxy using embedded defaults only.
// Note: Reading workspace config would be a security risk since untrusted code could be executed
// before the sandbox is fully set up. The proxy always uses safe, built-in defaults.
func setupProxyConfig(userInfo *userInfo) error {
	proxyDataDir := filepath.Join(dataDir, "proxy")
	configDest := filepath.Join(proxyDataDir, "config.yaml")

	// Ensure proxy data directory exists
	if err := os.MkdirAll(proxyDataDir, 0755); err != nil {
		return fmt.Errorf("failed to create proxy data dir: %w", err)
	}

	// Always use built-in defaults (with Docker caching enabled)
	// Security: Never read workspace config during init as it's untrusted code
	fmt.Printf("discobot-agent: using default proxy config with Docker caching enabled\n")

	// Write config with restrictive permissions (0644) and keep as root-owned
	// This prevents the discobot user from modifying the proxy configuration
	if err := os.WriteFile(configDest, defaultProxyConfig, 0644); err != nil {
		return fmt.Errorf("failed to write default proxy config: %w", err)
	}

	// Config remains root-owned for security (no chown needed)

	return nil
}

// runAgent starts the agent API process and manages its lifecycle
func runAgent(agentBinary string, u *userInfo, dockerCmd, proxyCmd *exec.Cmd) error {
	// Check if we're running as PID 1
	isPID1 := os.Getpid() == 1

	// Working directory is now /home/discobot/workspace
	workDir := filepath.Join(mountHome, "workspace")

	// Create the child process command
	cmd := exec.Command(agentBinary, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = workDir

	// Set up environment with correct user context
	cmd.Env = buildChildEnv(u, proxyCmd != nil)

	// Set up process attributes for user switching and pdeathsig
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid:    uint32(u.uid),
			Gid:    uint32(u.gid),
			Groups: u.groups,
		},
		// Send SIGTERM to child when parent dies
		Pdeathsig: syscall.SIGTERM,
		// Create new process group so signals can be forwarded
		Setpgid: true,
	}

	// Start the child process
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start %s: %w", agentBinary, err)
	}

	fmt.Printf("discobot-agent: started %s as user %s (pid=%d)\n", agentBinary, u.username, cmd.Process.Pid)

	// Set up signal handling
	signals := make(chan os.Signal, 10)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGQUIT, syscall.SIGHUP)

	// If running as PID 1, also handle SIGCHLD for process reaping
	if isPID1 {
		signal.Notify(signals, syscall.SIGCHLD)
	}

	// Channel to receive child process exit
	childDone := make(chan error, 1)
	go func() {
		childDone <- cmd.Wait()
	}()

	// Main event loop
	return eventLoop(cmd, dockerCmd, proxyCmd, signals, childDone, isPID1)
}

// eventLoop handles signals and waits for child process exit
func eventLoop(cmd *exec.Cmd, dockerCmd, proxyCmd *exec.Cmd, signals chan os.Signal, childDone chan error, isPID1 bool) error {
	shuttingDown := false

	for {
		select {
		case sig := <-signals:
			switch sig {
			case syscall.SIGCHLD:
				// Reap zombie processes (PID 1 responsibility)
				if isPID1 {
					reapChildren()
				}

			case syscall.SIGINT, syscall.SIGTERM, syscall.SIGQUIT:
				if !shuttingDown {
					shuttingDown = true
					fmt.Printf("discobot-agent: received %v, shutting down...\n", sig)

					// Forward signal to child process group
					if cmd.Process != nil {
						// Send to process group (negative pid)
						_ = syscall.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
					}

					// Start shutdown timer
					go func() {
						time.Sleep(shutdownTimeout)
						fmt.Fprintf(os.Stderr, "discobot-agent: shutdown timeout, forcing termination\n")
						if cmd.Process != nil {
							_ = cmd.Process.Kill()
						}
						// Also kill dockerd on timeout
						if dockerCmd != nil && dockerCmd.Process != nil {
							_ = dockerCmd.Process.Kill()
						}
					}()
				}

			case syscall.SIGHUP:
				// Forward SIGHUP to child for config reload
				if cmd.Process != nil {
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
				}
			}

		case err := <-childDone:
			// Child process exited
			exitCode := 0
			if err != nil {
				var exitErr *exec.ExitError
				if errors.As(err, &exitErr) {
					exitCode = exitErr.ExitCode()
					fmt.Printf("discobot-agent: child exited with code %d\n", exitCode)
				} else {
					fmt.Fprintf(os.Stderr, "discobot-agent: child error: %v\n", err)
					exitCode = 1
				}
			} else {
				fmt.Printf("discobot-agent: child exited successfully\n")
			}

			// Stop proxy daemon if running
			if proxyCmd != nil && proxyCmd.Process != nil {
				fmt.Printf("discobot-agent: stopping proxy daemon...\n")
				_ = proxyCmd.Process.Signal(syscall.SIGTERM)
				// Give it a moment to shut down gracefully
				done := make(chan struct{})
				go func() {
					_ = proxyCmd.Wait()
					close(done)
				}()
				select {
				case <-done:
					fmt.Printf("discobot-agent: proxy daemon stopped\n")
				case <-time.After(5 * time.Second):
					fmt.Printf("discobot-agent: proxy daemon did not stop, killing...\n")
					_ = proxyCmd.Process.Kill()
				}
			}

			// Stop Docker daemon if running
			if dockerCmd != nil && dockerCmd.Process != nil {
				fmt.Printf("discobot-agent: stopping Docker daemon...\n")
				_ = dockerCmd.Process.Signal(syscall.SIGTERM)
				// Give it a moment to shut down gracefully
				done := make(chan struct{})
				go func() {
					_ = dockerCmd.Wait()
					close(done)
				}()
				select {
				case <-done:
					fmt.Printf("discobot-agent: Docker daemon stopped\n")
				case <-time.After(5 * time.Second):
					fmt.Printf("discobot-agent: Docker daemon did not stop, killing...\n")
					_ = dockerCmd.Process.Kill()
				}
			}

			// Final reap of any remaining zombies
			if isPID1 {
				reapChildren()
			}

			os.Exit(exitCode)
		}
	}
}

// envOrDefault returns the environment variable value or the default if not set
func envOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// userInfo contains all information needed for user switching
type userInfo struct {
	uid      int
	gid      int
	username string
	homeDir  string
	groups   []uint32
}

// lookupUser returns user information for the given username
func lookupUser(username string) (*userInfo, error) {
	u, err := user.Lookup(username)
	if err != nil {
		return nil, err
	}

	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return nil, fmt.Errorf("invalid uid: %w", err)
	}

	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return nil, fmt.Errorf("invalid gid: %w", err)
	}

	// Get supplementary groups
	groupIDs, err := u.GroupIds()
	if err != nil {
		// Non-fatal: continue without supplementary groups
		groupIDs = nil
	}

	groups := make([]uint32, 0, len(groupIDs))
	for _, gidStr := range groupIDs {
		g, err := strconv.Atoi(gidStr)
		if err == nil {
			groups = append(groups, uint32(g))
		}
	}

	return &userInfo{
		uid:      uid,
		gid:      gid,
		username: u.Username,
		homeDir:  u.HomeDir,
		groups:   groups,
	}, nil
}

// buildChildEnv creates the environment for the child process
// It inherits from parent but overrides user-specific variables
func buildChildEnv(u *userInfo, proxyEnabled bool) []string {
	// Start with parent environment
	parentEnv := os.Environ()
	env := make([]string, 0, len(parentEnv)+12) // +3 for user vars, +9 for proxy vars (including NO_PROXY and NODE_EXTRA_CA_CERTS)

	// Copy parent env, excluding user-specific vars we'll override
	skipVars := map[string]bool{
		"HOME":    true,
		"USER":    true,
		"LOGNAME": true,
	}

	for _, e := range parentEnv {
		// Extract variable name (everything before first '=')
		if varName, _, ok := strings.Cut(e, "="); ok && !skipVars[varName] {
			env = append(env, e)
		}
	}

	// Set user-specific environment variables
	env = append(env,
		"HOME="+u.homeDir,
		"USER="+u.username,
		"LOGNAME="+u.username,
	)

	// Add proxy environment variables if proxy is running
	if proxyEnabled {
		env = append(env, getProxyEnvVars()...)
	}

	return env
}

// reapChildren collects zombie processes
// This is a PID 1 responsibility in Linux containers
func reapChildren() {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			break
		}
		// Zombie reaped, continue to check for more
	}
}

// ===== Cache Volume Mount Support =====

// cacheConfig defines the cache directory configuration.
type cacheConfig struct {
	AdditionalPaths []string `json:"additionalPaths,omitempty"`
}

// wellKnownCachePaths returns the list of well-known cache directories.
// Note: We only include .cache since all subdirectories under it will be cached.
func wellKnownCachePaths() []string {
	return []string{
		// Universal cache directory - all subdirectories will be cached
		"/home/discobot/.cache",

		// Package managers that don't use .cache
		"/home/discobot/.npm",
		"/home/discobot/.pnpm-store",
		"/home/discobot/.yarn",

		// Python
		"/home/discobot/.local/share/uv",

		// Go
		"/home/discobot/go/pkg/mod",

		// Rust / Cargo
		"/home/discobot/.cargo/registry",
		"/home/discobot/.cargo/git",

		// Ruby
		"/home/discobot/.bundle",
		"/home/discobot/.gem",

		// Java / Maven / Gradle
		"/home/discobot/.m2/repository",
		"/home/discobot/.gradle/caches",
		"/home/discobot/.gradle/wrapper",

		// .NET
		"/home/discobot/.nuget/packages",

		// PHP
		"/home/discobot/.composer/cache",

		// Bun
		"/home/discobot/.bun/install/cache",

		// Docker build cache (if Docker-in-Docker)
		"/home/discobot/.docker/buildx",

		// Build caches
		"/home/discobot/.ccache",

		// IDE caches
		"/home/discobot/.vscode-server",
		"/home/discobot/.cursor-server",
	}
}

// loadCacheConfig loads the cache configuration from the workspace.
// If the file doesn't exist or can't be read, returns default config.
func loadCacheConfig() *cacheConfig {
	configPath := filepath.Join(mountHome, "workspace", ".discobot", "cache.json")

	data, err := os.ReadFile(configPath)
	if err != nil {
		// No config file is not an error - return empty config
		return &cacheConfig{}
	}

	var cfg cacheConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		fmt.Printf("discobot-agent: warning: failed to parse cache config: %v\n", err)
		return &cacheConfig{}
	}

	return &cfg
}

// getAllCachePaths returns all cache paths (well-known + additional from config).
// Additional paths are validated to ensure they're within /home/discobot for security.
func getAllCachePaths(cfg *cacheConfig) []string {
	paths := make([]string, 0, len(wellKnownCachePaths())+len(cfg.AdditionalPaths))
	paths = append(paths, wellKnownCachePaths()...)

	// Validate and add additional paths
	for _, p := range cfg.AdditionalPaths {
		if isValidCachePath(p) {
			paths = append(paths, p)
		} else {
			fmt.Printf("discobot-agent: warning: ignoring invalid cache path from config: %s\n", p)
		}
	}

	return paths
}

// isValidCachePath checks if a path is safe to use as a cache directory.
// Only paths within /home/discobot are allowed for security.
func isValidCachePath(path string) bool {
	// Clean the path to resolve any .. or . components
	cleanPath := filepath.Clean(path)

	// Must be absolute path
	if !filepath.IsAbs(cleanPath) {
		return false
	}

	// Must be within /home/discobot (not equal to it, must be a subdirectory)
	homePrefix := "/home/discobot/"
	if !strings.HasPrefix(cleanPath+"/", homePrefix) {
		return false
	}

	// Must not contain any suspicious components
	// This prevents paths like /home/discobot/../etc
	if strings.Contains(cleanPath, "..") {
		return false
	}

	return true
}

// mountCacheDirectories bind-mounts cache directories from /.data/cache to /home/discobot/*.
// This is called after the overlay filesystem is mounted, so cache mounts sit on top of the overlay.
func mountCacheDirectories() error {
	// Check if CACHE_ENABLED environment variable is set
	if cacheEnabled := os.Getenv("CACHE_ENABLED"); cacheEnabled == "false" {
		fmt.Printf("discobot-agent: cache volumes disabled via CACHE_ENABLED=false\n")
		return nil
	}

	// Check if /.data/cache exists (created by Docker provider)
	cacheVolumeBase := filepath.Join(dataDir, "cache")
	if _, err := os.Stat(cacheVolumeBase); os.IsNotExist(err) {
		fmt.Printf("discobot-agent: cache volume not found at %s, skipping cache mounts\n", cacheVolumeBase)
		return nil
	}

	// Load cache configuration
	cfg := loadCacheConfig()

	// Get all cache paths
	cachePaths := getAllCachePaths(cfg)

	mounted := 0
	for _, cachePath := range cachePaths {
		// Clean the path to create a safe subdirectory name in the cache volume
		// e.g., "/home/discobot/.npm" -> "home/discobot/.npm"
		subDir := filepath.Clean(cachePath)
		if subDir[0] == '/' {
			subDir = subDir[1:]
		}

		// Source is in the cache volume
		source := filepath.Join(cacheVolumeBase, subDir)

		// Ensure the source directory exists in the cache volume with world-writable permissions
		// This allows all users/processes to write to cache directories
		if err := os.MkdirAll(source, 0777); err != nil {
			fmt.Printf("discobot-agent: warning: failed to create cache dir %s: %v\n", source, err)
			continue
		}
		// Explicitly set permissions to 0777 on the entire tree (umask may have restricted MkdirAll)
		chmodPathToRoot(source, cacheVolumeBase, 0777)

		// Ensure the target directory exists in the overlay with world-writable permissions
		if err := os.MkdirAll(cachePath, 0777); err != nil {
			fmt.Printf("discobot-agent: warning: failed to create target dir %s: %v\n", cachePath, err)
			continue
		}
		// Explicitly set permissions to 0777 on the entire tree (umask may have restricted MkdirAll)
		chmodPathToRoot(cachePath, "/home/discobot", 0777)

		// Bind mount the cache directory
		if err := syscall.Mount(source, cachePath, "none", syscall.MS_BIND, ""); err != nil {
			fmt.Printf("discobot-agent: warning: failed to bind mount %s to %s: %v\n", source, cachePath, err)
			continue
		}

		mounted++
	}

	if mounted > 0 {
		fmt.Printf("discobot-agent: mounted %d cache directories\n", mounted)
	}

	return nil
}

// chmodPathToRoot sets permissions on path and all parent directories up to (but not including) root.
// This ensures all intermediate directories created by MkdirAll have the correct permissions.
func chmodPathToRoot(path, root string, mode os.FileMode) {
	// Clean paths to normalize them
	path = filepath.Clean(path)
	root = filepath.Clean(root)

	// Walk up the directory tree from path to root
	current := path
	for current != root && current != "/" && current != "." {
		if err := os.Chmod(current, mode); err != nil {
			// Don't log every error as it's noisy; the leaf chmod failure is logged elsewhere
			break
		}
		current = filepath.Dir(current)
	}
}
