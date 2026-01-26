// Package main is the entry point for the octobot-agent init process.
// This binary runs as PID 1 in the container and handles:
// - Home directory initialization and workspace cloning
// - Filesystem setup (OverlayFS for new sessions, AgentFS for existing)
// - Process reaping (zombie collection)
// - User switching from root to octobot
// - Child process management with pdeathsig
// - Signal forwarding for graceful shutdown
package main

import (
	"errors"
	"fmt"
	"io"
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

const (
	// Default binary to execute
	defaultAgentBinary = "/opt/octobot/bin/obot-agent-api"

	// Default user to run as
	defaultUser = "octobot"

	// Shutdown timeout before forcing child termination
	shutdownTimeout = 10 * time.Second

	// Docker daemon startup timeout
	dockerStartupTimeout = 30 * time.Second

	// Docker socket path
	dockerSocketPath = "/var/run/docker.sock"

	// Paths
	dataDir         = "/.data"
	baseHomeDir     = "/.data/octobot"           // Base home directory (copied from /home/octobot)
	workspaceDir    = "/.data/octobot/workspace" // Workspace inside home
	stagingDir      = "/.data/octobot/workspace.staging"
	agentFSDir      = "/.data/.agentfs"
	overlayFSDir    = "/.data/.overlayfs"
	mountHome       = "/home/octobot"     // Where agentfs/overlayfs mounts
	symlinkPath     = "/workspace"        // Symlink to /home/octobot/workspace
	tempMigrationFS = "/.data/.migration" // Temporary mount point for migration
)

// filesystemType represents the type of filesystem to use for session isolation
type filesystemType int

const (
	fsTypeOverlayFS filesystemType = iota
	fsTypeAgentFS
)

// detectFilesystemType determines which filesystem to use based on existing data.
// If an agentfs database exists for the session, use agentfs for backwards compatibility.
// Otherwise, use overlayfs for new sessions.
func detectFilesystemType(sessionID string) filesystemType {
	// Check for environment variable override
	if fsOverride := os.Getenv("OCTOBOT_FILESYSTEM"); fsOverride != "" {
		switch strings.ToLower(fsOverride) {
		case "agentfs":
			fmt.Printf("octobot-agent: filesystem override: agentfs\n")
			return fsTypeAgentFS
		case "overlayfs":
			fmt.Printf("octobot-agent: filesystem override: overlayfs\n")
			return fsTypeOverlayFS
		}
	}

	// Check if migration marker exists (session has already been migrated)
	migrationMarker := filepath.Join(overlayFSDir, sessionID, ".migrated")
	if _, err := os.Stat(migrationMarker); err == nil {
		fmt.Printf("octobot-agent: session already migrated to overlayfs\n")
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
	fmt.Printf("octobot-agent: starting migration from agentfs to overlayfs for session %s\n", sessionID)

	// Ensure migration directory exists
	if err := os.MkdirAll(tempMigrationFS, 0755); err != nil {
		return fmt.Errorf("failed to create migration directory: %w", err)
	}

	// Step 1: Mount agentfs at temporary location
	fmt.Printf("octobot-agent: mounting agentfs at temporary location %s\n", tempMigrationFS)
	if err := mountAgentFSAtPath(sessionID, tempMigrationFS, userInfo); err != nil {
		return fmt.Errorf("failed to mount agentfs for migration: %w", err)
	}

	// Ensure cleanup on error
	defer func() {
		fmt.Printf("octobot-agent: unmounting temporary agentfs\n")
		if err := syscall.Unmount(tempMigrationFS, 0); err != nil {
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to unmount %s: %v\n", tempMigrationFS, err)
		}
	}()

	// Step 2: Setup overlayfs directories at target location
	fmt.Printf("octobot-agent: setting up overlayfs for migration\n")
	if err := setupOverlayFS(sessionID, userInfo); err != nil {
		return fmt.Errorf("failed to setup overlayfs for migration: %w", err)
	}

	// Step 3: Mount overlayfs at target
	fmt.Printf("octobot-agent: mounting overlayfs at %s\n", mountHome)
	if err := mountOverlayFS(sessionID); err != nil {
		// Clean up overlayfs directories if mount fails
		if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
		}
		return fmt.Errorf("failed to mount overlayfs for migration: %w", err)
	}

	// Ensure overlayfs cleanup on error
	defer func() {
		// Only unmount if we're returning an error (normal path will keep it mounted)
		if r := recover(); r != nil {
			fmt.Printf("octobot-agent: unmounting overlayfs due to panic\n")
			if unmountErr := syscall.Unmount(mountHome, 0); unmountErr != nil {
				fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to unmount overlayfs: %v\n", unmountErr)
			}
			panic(r)
		}
	}()

	// Step 4: Rsync from temp agentfs to target overlayfs
	fmt.Printf("octobot-agent: syncing data from agentfs to overlayfs (this may take a while)\n")
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
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to unmount overlayfs: %v\n", unmountErr)
		}
		if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
		}
		return fmt.Errorf("rsync failed: %w", err)
	}

	fmt.Printf("octobot-agent: data sync completed successfully\n")

	// Step 5: Unmount temporary agentfs
	fmt.Printf("octobot-agent: unmounting temporary agentfs\n")
	if err := syscall.Unmount(tempMigrationFS, 0); err != nil {
		fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to unmount temporary agentfs: %v\n", err)
		// Continue anyway - this is not fatal
	}

	// Step 6: Create migration marker
	migrationMarker := filepath.Join(overlayFSDir, sessionID, ".migrated")
	fmt.Printf("octobot-agent: creating migration marker at %s\n", migrationMarker)
	if err := os.WriteFile(migrationMarker, []byte(time.Now().Format(time.RFC3339)), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to create migration marker: %v\n", err)
		// Continue anyway - the migration is complete
	}

	fmt.Printf("octobot-agent: migration completed successfully\n")
	fmt.Printf("octobot-agent: note: agentfs database is preserved at %s for backup\n", filepath.Join(agentFSDir, sessionID+".db"))

	return nil
}

// mountAgentFSAtPath mounts agentfs at a specific path (used for migration)
func mountAgentFSAtPath(sessionID, mountPath string, u *userInfo) error {
	const maxRetries = 3

	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("octobot-agent: mounting agentfs %s at %s (attempt %d/%d)\n", sessionID, mountPath, attempt, maxRetries)

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
			fmt.Fprintf(os.Stderr, "octobot-agent: agentfs mount attempt %d failed: %v\n", attempt, err)
			if attempt < maxRetries {
				time.Sleep(time.Second)
			}
			continue
		}

		fmt.Printf("octobot-agent: agentfs mounted successfully at %s\n", mountPath)
		return nil
	}

	return fmt.Errorf("agentfs mount failed after %d retries: %w", maxRetries, lastErr)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "octobot-agent: %v\n", err)
		// Sleep forever to allow debugging via docker exec
		fmt.Fprintf(os.Stderr, "octobot-agent: sleeping for debug (docker exec to investigate)\n")
		sig := make(chan os.Signal, 1)
		signal.Notify(sig)
		<-sig
	}
}

func run() error {
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
	if err := setupGitSafeDirectories(workspacePath); err != nil {
		return fmt.Errorf("git safe.directory setup failed: %w", err)
	}

	// Step 1: Setup base home directory (copy from /home/octobot if needed)
	if err := setupBaseHome(userInfo); err != nil {
		return fmt.Errorf("base home setup failed: %w", err)
	}

	// Step 2: Setup workspace (clone if needed)
	if err := setupWorkspace(workspacePath, workspaceCommit, userInfo); err != nil {
		return fmt.Errorf("workspace setup failed: %w", err)
	}

	// Step 3: Detect filesystem type (overlayfs for new sessions, agentfs for existing)
	fsType := detectFilesystemType(sessionID)

	// Step 4: Setup and mount filesystem based on type
	switch fsType {
	case fsTypeAgentFS:
		fmt.Printf("octobot-agent: agentfs session detected, migrating to overlayfs\n")

		// Ensure agentfs directory exists with correct ownership
		if err := os.MkdirAll(agentFSDir, 0755); err != nil {
			return fmt.Errorf("failed to create agentfs directory: %w", err)
		}
		if err := os.Chown(agentFSDir, userInfo.uid, userInfo.gid); err != nil {
			return fmt.Errorf("failed to chown agentfs directory: %w", err)
		}

		// Initialize agentfs database if needed (as octobot user)
		if err := initAgentFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("agentfs init failed: %w", err)
		}

		// Perform migration from agentfs to overlayfs
		if err := migrateAgentFSToOverlayFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("migration from agentfs to overlayfs failed: %w", err)
		}

	case fsTypeOverlayFS:
		fmt.Printf("octobot-agent: using OverlayFS (new session)\n")

		// Setup overlayfs directory structure
		if err := setupOverlayFS(sessionID, userInfo); err != nil {
			return fmt.Errorf("overlayfs setup failed: %w", err)
		}

		// Mount overlayfs over /home/octobot
		if err := mountOverlayFS(sessionID); err != nil {
			// Fallback to agentfs if overlayfs fails
			fmt.Printf("octobot-agent: overlayfs failed, falling back to agentfs: %v\n", err)
			if cleanErr := os.RemoveAll(filepath.Join(overlayFSDir, sessionID)); cleanErr != nil {
				fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to cleanup overlayfs directory: %v\n", cleanErr)
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

	// Step 5: Create /workspace symlink to /home/octobot/workspace
	if err := createWorkspaceSymlink(); err != nil {
		return fmt.Errorf("symlink creation failed: %w", err)
	}

	// Step 6: Start Docker daemon if available
	dockerCmd, err := startDockerDaemon()
	if err != nil {
		// Log but don't fail - Docker is optional
		fmt.Printf("octobot-agent: Docker daemon not started: %v\n", err)
	}

	// Step 7: Run the agent API
	return runAgent(agentBinary, userInfo, dockerCmd)
}

// setupGitSafeDirectories configures git safe.directory for all workspace paths.
// Uses --system to write to /etc/gitconfig so all users (including octobot) can see it.
func setupGitSafeDirectories(workspacePath string) error {
	// Paths that need to be marked as safe for git operations
	dirs := []string{
		"/.workspace",                         // Source workspace mount point
		"/.workspace/.git",                    // Git directory (some operations check .git specifically)
		workspaceDir,                          // /.data/octobot/workspace
		stagingDir,                            // /.data/octobot/workspace.staging (used during clone)
		filepath.Join(mountHome, "workspace"), // /home/octobot/workspace (after agentfs mount)
		symlinkPath,                           // /workspace symlink
	}

	// Add the specific workspacePath if provided and different from /.workspace
	if workspacePath != "" && workspacePath != "/.workspace" {
		dirs = append([]string{workspacePath}, dirs...)
	}

	fmt.Printf("octobot-agent: configuring git safe.directory for workspace paths\n")
	for _, dir := range dirs {
		cmd := exec.Command("git", "config", "--system", "--add", "safe.directory", dir)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			// Log but don't fail - some paths may not exist yet
			fmt.Printf("octobot-agent: warning: git config safe.directory %s: %v\n", dir, err)
		}
	}

	return nil
}

// setupBaseHome copies /home/octobot to /.data/octobot if it doesn't exist,
// or syncs new files if it already exists
func setupBaseHome(u *userInfo) error {
	// Check if base home already exists
	if _, err := os.Stat(baseHomeDir); err == nil {
		fmt.Printf("octobot-agent: base home already exists at %s, syncing new files\n", baseHomeDir)
		// Sync any new files from /home/octobot to /.data/octobot
		// This ensures new files added to the container image get propagated
		if err := syncNewFiles(mountHome, baseHomeDir, u); err != nil {
			return fmt.Errorf("failed to sync new files: %w", err)
		}
		return nil
	}

	fmt.Printf("octobot-agent: copying /home/octobot to %s\n", baseHomeDir)

	// Create parent directory
	if err := os.MkdirAll(filepath.Dir(baseHomeDir), 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}

	// Copy /home/octobot to /.data/octobot recursively with permissions
	if err := copyDir(mountHome, baseHomeDir); err != nil {
		return fmt.Errorf("failed to copy home directory: %w", err)
	}

	// Ensure ownership is correct
	if err := chownRecursive(baseHomeDir, u.uid, u.gid); err != nil {
		return fmt.Errorf("failed to chown base home: %w", err)
	}

	fmt.Printf("octobot-agent: base home created successfully\n")
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
			fmt.Printf("octobot-agent: syncing new directory %s\n", relPath)
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
			fmt.Printf("octobot-agent: syncing new symlink %s\n", relPath)
			if err := os.Symlink(link, dstPath); err != nil {
				return err
			}
			if err := os.Lchown(dstPath, u.uid, u.gid); err != nil {
				return err
			}
		} else if info.Mode().IsRegular() {
			fmt.Printf("octobot-agent: syncing new file %s\n", relPath)
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
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to close source file %s: %v\n", src, closeErr)
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
			fmt.Fprintf(os.Stderr, "octobot-agent: warning: failed to close destination file %s: %v\n", dst, closeErr)
		}
	}()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

// setupWorkspace clones the workspace if it doesn't exist.
func setupWorkspace(workspacePath, workspaceCommit string, u *userInfo) error {
	// If workspace already exists, nothing to do
	if _, err := os.Stat(workspaceDir); err == nil {
		fmt.Printf("octobot-agent: workspace already exists at %s\n", workspaceDir)
		return nil
	}

	// If no workspace path specified, create empty workspace owned by user
	if workspacePath == "" {
		fmt.Println("octobot-agent: no WORKSPACE_PATH specified, creating empty workspace")
		if err := os.MkdirAll(workspaceDir, 0755); err != nil {
			return fmt.Errorf("failed to create workspace directory: %w", err)
		}
		if err := os.Chown(workspaceDir, u.uid, u.gid); err != nil {
			return fmt.Errorf("failed to chown workspace directory: %w", err)
		}
		return nil
	}

	fmt.Printf("octobot-agent: cloning workspace from %s\n", workspacePath)

	// Clean up any existing staging directory
	if err := os.RemoveAll(stagingDir); err != nil {
		return fmt.Errorf("failed to remove staging directory: %w", err)
	}

	// Note: git safe.directory is configured system-wide in setupGitSafeDirectories()

	// Clone to staging directory first
	cloneArgs := []string{"clone", "--single-branch"}
	if workspaceCommit != "" {
		cloneArgs = append(cloneArgs, "--no-checkout")
	}
	cloneArgs = append(cloneArgs, workspacePath, stagingDir)

	cmd := exec.Command("git", cloneArgs...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	fmt.Printf("octobot-agent: running: git %v\n", cloneArgs)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git clone failed: %w", err)
	}

	// If specific commit requested, checkout that commit
	if workspaceCommit != "" {
		cmd = exec.Command("git", "-C", stagingDir, "checkout", workspaceCommit)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("git checkout %s failed: %w", workspaceCommit, err)
		}
	}

	// Change ownership of all files to the target user
	fmt.Printf("octobot-agent: changing workspace ownership to %s\n", u.username)
	if err := chownRecursive(stagingDir, u.uid, u.gid); err != nil {
		return fmt.Errorf("failed to chown workspace: %w", err)
	}

	// Atomically move staging to final location
	if err := os.Rename(stagingDir, workspaceDir); err != nil {
		return fmt.Errorf("failed to move staging to workspace: %w", err)
	}

	fmt.Printf("octobot-agent: workspace cloned successfully\n")
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
		fmt.Printf("octobot-agent: agentfs database already exists at %s\n", dbPath)
		return nil
	}

	fmt.Printf("octobot-agent: initializing agentfs for session %s\n", sessionID)

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

	fmt.Printf("octobot-agent: agentfs initialized successfully\n")
	return nil
}

// mountAgentFS mounts the agentfs database over /home/octobot
// It retries up to 3 times, then attempts foreground mode for debug output
func mountAgentFS(sessionID string, u *userInfo) error {
	const maxRetries = 3

	// Try mounting in daemon mode (with -a flag) up to maxRetries times
	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		fmt.Printf("octobot-agent: mounting agentfs %s at %s (attempt %d/%d)\n", sessionID, mountHome, attempt, maxRetries)

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
			fmt.Fprintf(os.Stderr, "octobot-agent: agentfs mount attempt %d failed: %v\n", attempt, err)
			if attempt < maxRetries {
				time.Sleep(time.Second) // Brief delay before retry
			}
			continue
		}

		fmt.Printf("octobot-agent: agentfs mounted successfully\n")
		return nil
	}

	// All retries failed - try foreground mode to capture debug output
	fmt.Fprintf(os.Stderr, "octobot-agent: ERROR: agentfs mount failed %d times\n", maxRetries)
	fmt.Fprintf(os.Stderr, "octobot-agent: attempting foreground mount to capture debug logs...\n")

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
		fmt.Fprintf(os.Stderr, "octobot-agent: foreground mount also failed: %v\n", err)
		fmt.Fprintf(os.Stderr, "octobot-agent: sleeping forever for debug (docker exec to investigate)\n")
		sig := make(chan os.Signal, 1)
		signal.Notify(sig)
		<-sig
		// Won't reach here, but return for completeness
		return fmt.Errorf("agentfs mount failed after %d retries and foreground attempt: %w", maxRetries, lastErr)
	}

	// Foreground mount succeeded (unexpected but handle it)
	fmt.Printf("octobot-agent: agentfs foreground mount succeeded\n")
	return nil
}

// setupOverlayFS creates the directory structure for overlayfs
func setupOverlayFS(sessionID string, u *userInfo) error {
	sessionDir := filepath.Join(overlayFSDir, sessionID)
	upperDir := filepath.Join(sessionDir, "upper")
	workDir := filepath.Join(sessionDir, "work")

	fmt.Printf("octobot-agent: setting up overlayfs directories at %s\n", sessionDir)

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

	fmt.Printf("octobot-agent: overlayfs directories created successfully\n")
	return nil
}

// mountOverlayFS mounts the overlayfs filesystem over /home/octobot
func mountOverlayFS(sessionID string) error {
	sessionDir := filepath.Join(overlayFSDir, sessionID)
	upperDir := filepath.Join(sessionDir, "upper")
	workDir := filepath.Join(sessionDir, "work")

	// Construct mount options:
	// lowerdir = read-only base layer
	// upperdir = writable layer for changes
	// workdir = scratch space for overlayfs internal use
	opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", baseHomeDir, upperDir, workDir)

	fmt.Printf("octobot-agent: mounting overlayfs at %s\n", mountHome)
	fmt.Printf("octobot-agent: overlayfs options: %s\n", opts)

	if err := syscall.Mount("overlay", mountHome, "overlay", 0, opts); err != nil {
		return fmt.Errorf("overlayfs mount failed: %w", err)
	}

	fmt.Printf("octobot-agent: overlayfs mounted successfully\n")
	return nil
}

// createWorkspaceSymlink creates /workspace -> /home/octobot/workspace symlink
func createWorkspaceSymlink() error {
	target := filepath.Join(mountHome, "workspace")

	// Remove existing symlink or file if present
	if _, err := os.Lstat(symlinkPath); err == nil {
		if err := os.Remove(symlinkPath); err != nil {
			return fmt.Errorf("failed to remove existing %s: %w", symlinkPath, err)
		}
	}

	fmt.Printf("octobot-agent: creating symlink %s -> %s\n", symlinkPath, target)
	if err := os.Symlink(target, symlinkPath); err != nil {
		return fmt.Errorf("failed to create symlink: %w", err)
	}

	return nil
}

// startDockerDaemon starts the Docker daemon if dockerd is available on PATH.
// Returns the running command (for cleanup) or nil if Docker is not available.
func startDockerDaemon() (*exec.Cmd, error) {
	// Check if dockerd is on PATH
	dockerdPath, err := exec.LookPath("dockerd")
	if err != nil {
		return nil, fmt.Errorf("dockerd not found on PATH: %w", err)
	}

	fmt.Printf("octobot-agent: found dockerd at %s, starting Docker daemon...\n", dockerdPath)

	// Ensure /var/run exists for the socket
	if err := os.MkdirAll("/var/run", 0755); err != nil {
		return nil, fmt.Errorf("failed to create /var/run: %w", err)
	}

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
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start dockerd: %w", err)
	}

	fmt.Printf("octobot-agent: dockerd started (pid=%d), waiting for socket...\n", cmd.Process.Pid)

	// Wait for the Docker socket to become available
	if err := waitForDockerSocket(); err != nil {
		// Kill dockerd if socket never appeared
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("docker socket did not become available: %w", err)
	}

	// Make the socket world-readable and writable
	if err := os.Chmod(dockerSocketPath, 0666); err != nil {
		fmt.Printf("octobot-agent: warning: failed to chmod docker socket: %v\n", err)
	} else {
		fmt.Printf("octobot-agent: docker socket permissions set to 0666\n")
	}

	fmt.Printf("octobot-agent: Docker daemon ready\n")
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

// runAgent starts the agent API process and manages its lifecycle
func runAgent(agentBinary string, u *userInfo, dockerCmd *exec.Cmd) error {
	// Check if we're running as PID 1
	isPID1 := os.Getpid() == 1

	// Working directory is now /home/octobot/workspace
	workDir := filepath.Join(mountHome, "workspace")

	// Create the child process command
	cmd := exec.Command(agentBinary, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = workDir

	// Set up environment with correct user context
	cmd.Env = buildChildEnv(u)

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

	fmt.Printf("octobot-agent: started %s as user %s (pid=%d)\n", agentBinary, u.username, cmd.Process.Pid)

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
	return eventLoop(cmd, dockerCmd, signals, childDone, isPID1)
}

// eventLoop handles signals and waits for child process exit
func eventLoop(cmd *exec.Cmd, dockerCmd *exec.Cmd, signals chan os.Signal, childDone chan error, isPID1 bool) error {
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
					fmt.Printf("octobot-agent: received %v, shutting down...\n", sig)

					// Forward signal to child process group
					if cmd.Process != nil {
						// Send to process group (negative pid)
						_ = syscall.Kill(-cmd.Process.Pid, sig.(syscall.Signal))
					}

					// Start shutdown timer
					go func() {
						time.Sleep(shutdownTimeout)
						fmt.Fprintf(os.Stderr, "octobot-agent: shutdown timeout, forcing termination\n")
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
					fmt.Printf("octobot-agent: child exited with code %d\n", exitCode)
				} else {
					fmt.Fprintf(os.Stderr, "octobot-agent: child error: %v\n", err)
					exitCode = 1
				}
			} else {
				fmt.Printf("octobot-agent: child exited successfully\n")
			}

			// Stop Docker daemon if running
			if dockerCmd != nil && dockerCmd.Process != nil {
				fmt.Printf("octobot-agent: stopping Docker daemon...\n")
				_ = dockerCmd.Process.Signal(syscall.SIGTERM)
				// Give it a moment to shut down gracefully
				done := make(chan struct{})
				go func() {
					_ = dockerCmd.Wait()
					close(done)
				}()
				select {
				case <-done:
					fmt.Printf("octobot-agent: Docker daemon stopped\n")
				case <-time.After(5 * time.Second):
					fmt.Printf("octobot-agent: Docker daemon did not stop, killing...\n")
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
func buildChildEnv(u *userInfo) []string {
	// Start with parent environment
	parentEnv := os.Environ()
	env := make([]string, 0, len(parentEnv)+4)

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
