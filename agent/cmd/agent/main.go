// Package main is the entry point for the octobot-agent init process.
// This binary runs as PID 1 in the container and handles:
// - Home directory initialization and workspace cloning
// - AgentFS setup and mounting over /home/octobot
// - Process reaping (zombie collection)
// - User switching from root to octobot
// - Child process management with pdeathsig
// - Signal forwarding for graceful shutdown
package main

import (
	"errors"
	"fmt"
	"io"
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

	// Paths
	dataDir      = "/.data"
	baseHomeDir  = "/.data/octobot"           // Base home directory (copied from /home/octobot)
	workspaceDir = "/.data/octobot/workspace" // Workspace inside home
	stagingDir   = "/.data/octobot/workspace.staging"
	agentFSDir   = "/.data/.agentfs"
	mountHome    = "/home/octobot" // Where agentfs mounts
	symlinkPath  = "/workspace"    // Symlink to /home/octobot/workspace
)

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

	// Step 1: Setup base home directory (copy from /home/octobot if needed)
	if err := setupBaseHome(userInfo); err != nil {
		return fmt.Errorf("base home setup failed: %w", err)
	}

	// Step 2: Setup workspace (clone if needed)
	if err := setupWorkspace(workspacePath, workspaceCommit, userInfo); err != nil {
		return fmt.Errorf("workspace setup failed: %w", err)
	}

	// Step 3: Ensure agentfs directory exists with correct ownership
	if err := os.MkdirAll(agentFSDir, 0755); err != nil {
		return fmt.Errorf("failed to create agentfs directory: %w", err)
	}
	if err := os.Chown(agentFSDir, userInfo.uid, userInfo.gid); err != nil {
		return fmt.Errorf("failed to chown agentfs directory: %w", err)
	}

	// Step 4: Initialize agentfs database if needed (as octobot user)
	if err := initAgentFS(sessionID, userInfo); err != nil {
		return fmt.Errorf("agentfs init failed: %w", err)
	}

	// Step 5: Mount agentfs over /home/octobot
	if err := mountAgentFS(sessionID, userInfo); err != nil {
		return fmt.Errorf("agentfs mount failed: %w", err)
	}

	// Step 6: Create /workspace symlink to /home/octobot/workspace
	if err := createWorkspaceSymlink(); err != nil {
		return fmt.Errorf("symlink creation failed: %w", err)
	}

	// Step 7: Run the agent API
	return runAgent(agentBinary, userInfo)
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
	defer srcFile.Close()

	srcInfo, err := srcFile.Stat()
	if err != nil {
		return err
	}

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, srcInfo.Mode().Perm())
	if err != nil {
		return err
	}
	defer dstFile.Close()

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

	// Mark the source directory as safe for git
	safeCmd := exec.Command("git", "config", "--global", "--add", "safe.directory", workspacePath+"/.git")
	safeCmd.Stdout = os.Stdout
	safeCmd.Stderr = os.Stderr
	fmt.Printf("octobot-agent: running: git %v\n", safeCmd.Args)
	if err := safeCmd.Run(); err != nil {
		return fmt.Errorf("git config safe.directory failed: %w", err)
	}

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
		cmd = exec.Command("git", "-c", "safe.directory="+stagingDir, "-C", stagingDir, "checkout", workspaceCommit)
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
func mountAgentFS(sessionID string, u *userInfo) error {
	fmt.Printf("octobot-agent: mounting agentfs %s at %s\n", sessionID, mountHome)

	// -a: auto-unmount on exit
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
		return fmt.Errorf("agentfs mount failed: %w", err)
	}

	fmt.Printf("octobot-agent: agentfs mounted successfully\n")
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

// runAgent starts the agent API process and manages its lifecycle
func runAgent(agentBinary string, u *userInfo) error {
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
	return eventLoop(cmd, signals, childDone, isPID1)
}

// eventLoop handles signals and waits for child process exit
func eventLoop(cmd *exec.Cmd, signals chan os.Signal, childDone chan error, isPID1 bool) error {
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
