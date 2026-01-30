# Init Process Design

This document describes the design of the `discobot-agent` init process.

## Problem Statement

Container environments require a proper init process (PID 1) to handle:

1. **Home Directory Setup**: Copy user home directory template to persistent storage
2. **Workspace Initialization**: Clone git repositories to persistent storage
3. **Filesystem Setup**: Configure copy-on-write mount (OverlayFS for new sessions, AgentFS for existing)
4. **Zombie Reaping**: Orphaned processes become zombies without a parent to call `wait()`
5. **Signal Handling**: PID 1 has special signal semantics in Linux
6. **Graceful Shutdown**: Containers need orderly shutdown on `docker stop`
7. **User Isolation**: Security best practice is to run workloads as non-root

Previously, the container used `tini` as an init, but this didn't provide:
- Home directory setup
- Workspace cloning
- AgentFS integration
- User switching (had to rely on Docker's `--user` flag)
- Custom signal handling (SIGHUP for config reload)
- Integration with pdeathsig for child process management

## Solution

A custom Go-based init process that combines:
- Home directory initialization (copy template)
- Workspace initialization (git clone)
- Filesystem detection and mount (OverlayFS for new sessions, AgentFS for existing)
- Symlink creation for /workspace convenience
- Minimal init responsibilities (reaping, signal forwarding)
- User switching (`setuid`/`setgid`)
- Pdeathsig setup for reliable child termination

## Implementation Details

### Home Directory Setup

The home directory is copied from the container image template on first run:

```go
func setupBaseHome(u *userInfo) error {
    // Skip if already exists
    if _, err := os.Stat(baseHomeDir); err == nil {
        return nil
    }

    // Copy /home/discobot to /.data/discobot recursively
    if err := copyDir(mountHome, baseHomeDir); err != nil {
        return err
    }

    // Ensure ownership is correct
    return chownRecursive(baseHomeDir, u.uid, u.gid)
}
```

This ensures:
- First container start creates persistent home directory
- Subsequent starts reuse existing home directory
- File permissions and ownership are preserved

### Workspace Cloning

The workspace clone uses a staging directory for atomicity:

```go
func setupWorkspace(workspacePath, workspaceCommit string, u *userInfo) error {
    // Skip if already exists
    if _, err := os.Stat(workspaceDir); err == nil {
        return nil
    }

    // Clean up any failed staging
    os.RemoveAll(stagingDir)

    // Clone to staging first
    cmd := exec.Command("git", "clone", "--single-branch", workspacePath, stagingDir)
    if err := cmd.Run(); err != nil {
        return err
    }

    // Checkout specific commit if requested
    if workspaceCommit != "" {
        cmd = exec.Command("git", "-C", stagingDir, "checkout", workspaceCommit)
        if err := cmd.Run(); err != nil {
            return err
        }
    }

    // Change ownership to target user
    chownRecursive(stagingDir, u.uid, u.gid)

    // Atomic rename
    return os.Rename(stagingDir, workspaceDir)
}
```

This ensures:
- Failed clones don't leave partial state
- Concurrent container starts are safe
- Specific commits can be checked out

### Filesystem Setup

The init process supports two filesystem backends for copy-on-write semantics:

#### Filesystem Detection

```go
func detectFilesystemType(sessionID string) filesystemType {
    // Check for environment variable override
    if fsOverride := os.Getenv("DISCOBOT_FILESYSTEM"); fsOverride != "" {
        switch strings.ToLower(fsOverride) {
        case "agentfs":
            return fsTypeAgentFS
        case "overlayfs":
            return fsTypeOverlayFS
        }
    }

    // Default: check for existing agentfs database
    dbPath := filepath.Join(agentFSDir, sessionID+".db")
    if _, err := os.Stat(dbPath); err == nil {
        return fsTypeAgentFS
    }
    return fsTypeOverlayFS
}
```

Detection logic:
- If `DISCOBOT_FILESYSTEM` env var is set, use that filesystem
- If `/.data/.agentfs/{SESSION_ID}.db` exists, use AgentFS (backwards compatibility)
- Otherwise, use OverlayFS (new default)

#### OverlayFS (Default for New Sessions)

OverlayFS is a Linux kernel filesystem that provides copy-on-write without FUSE overhead:

```go
func setupOverlayFS(sessionID string, u *userInfo) error {
    sessionDir := filepath.Join(overlayFSDir, sessionID)
    upperDir := filepath.Join(sessionDir, "upper")
    workDir := filepath.Join(sessionDir, "work")

    // Create directories
    for _, dir := range []string{overlayFSDir, sessionDir, upperDir, workDir} {
        os.MkdirAll(dir, 0755)
    }

    // Set ownership
    for _, dir := range []string{sessionDir, upperDir, workDir} {
        os.Chown(dir, u.uid, u.gid)
    }
    return nil
}

func mountOverlayFS(sessionID string) error {
    sessionDir := filepath.Join(overlayFSDir, sessionID)
    upperDir := filepath.Join(sessionDir, "upper")
    workDir := filepath.Join(sessionDir, "work")

    opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", baseHomeDir, upperDir, workDir)
    return syscall.Mount("overlay", mountHome, "overlay", 0, opts)
}
```

OverlayFS advantages:
- Kernel-native (no FUSE overhead)
- Changes stored directly in filesystem (`/.data/.overlayfs/{SESSION_ID}/upper/`)
- Lower memory and CPU overhead

#### AgentFS (For Existing Sessions)

AgentFS provides copy-on-write via FUSE and SQLite:

```go
// Initialize database with base layer
func initAgentFS(sessionID string, u *userInfo) error {
    dbPath := filepath.Join(agentFSDir, sessionID+".db")
    if _, err := os.Stat(dbPath); err == nil {
        return nil // Already initialized
    }

    cmd := exec.Command("agentfs", "init", "--base", baseHomeDir, sessionID)
    cmd.Dir = dataDir
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Credential: &syscall.Credential{
            Uid: uint32(u.uid),
            Gid: uint32(u.gid),
        },
    }
    return cmd.Run()
}

// Mount directly over /home/discobot
func mountAgentFS(sessionID string, u *userInfo) error {
    // -a: auto-unmount on exit
    // --allow-root: allow root to access the FUSE mount
    cmd := exec.Command("agentfs", "mount", "-a", "--allow-root", sessionID, mountHome)
    cmd.Dir = dataDir
    cmd.SysProcAttr = &syscall.SysProcAttr{
        Credential: &syscall.Credential{
            Uid: uint32(u.uid),
            Gid: uint32(u.gid),
        },
    }
    return cmd.Run()
}
```

The AgentFS mount runs as the discobot user because:
- FUSE filesystems are owned by the mounting user
- This allows the agent to read/write files
- The `--allow-root` flag allows root access (needed for docker exec)

#### Fallback Behavior

If OverlayFS mount fails (e.g., unsupported kernel), the init process automatically falls back to AgentFS

### Workspace Symlink

A symlink provides convenient access to the workspace:

```go
func createWorkspaceSymlink() error {
    target := filepath.Join(mountHome, "workspace")

    // Remove existing symlink if present
    if _, err := os.Lstat(symlinkPath); err == nil {
        os.Remove(symlinkPath)
    }

    return os.Symlink(target, symlinkPath)
}
```

This creates `/workspace -> /home/discobot/workspace` for tools that expect `/workspace`.

### User Switching

```go
cmd.SysProcAttr = &syscall.SysProcAttr{
    Credential: &syscall.Credential{
        Uid:    uint32(uid),
        Gid:    uint32(gid),
        Groups: groups,
    },
    Pdeathsig: syscall.SIGTERM,
    Setpgid: true,
}
```

The user switch happens at `exec()` time via `Credential`. This is more secure than:
- Running the entire container as non-root (limits what init can do)
- Using `su` or `gosu` (adds process overhead)

### Environment Setup

```go
func buildChildEnv(u *userInfo) []string {
    env := filterEnv(os.Environ(), "HOME", "USER", "LOGNAME")
    return append(env,
        "HOME="+u.homeDir,
        "USER="+u.username,
        "LOGNAME="+u.username,
    )
}
```

### Process Groups

Child processes are placed in their own process group (`Setpgid: true`). This allows:
- Sending signals to all children at once (`kill(-pid, sig)`)
- Clean separation between init and workload processes

### Zombie Reaping

```go
func reapChildren() {
    for {
        pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
        if pid <= 0 || err != nil {
            break
        }
    }
}
```

The reaper runs on SIGCHLD and on final shutdown. Using `WNOHANG` ensures non-blocking behavior.

### Shutdown Sequence

```
SIGTERM received
    │
    ├─► Mark shuttingDown = true
    │
    ├─► Forward SIGTERM to child process group
    │
    ├─► Start 10-second timeout goroutine
    │
    └─► Wait for:
        ├─► Child exits normally → propagate exit code
        └─► Timeout → SIGKILL child → exit(1)
```

## Required Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| SESSION_ID | Yes | Unique identifier for filesystem isolation |
| WORKSPACE_PATH | No | Git URL to clone |
| WORKSPACE_COMMIT | No | Specific commit to checkout |
| AGENT_BINARY | No | Override agent API binary path |
| AGENT_USER | No | Override user to run as |
| DISCOBOT_FILESYSTEM | No | Force filesystem type: `overlayfs` or `agentfs` |

## Directories Created

The init process creates the following directories with `discobot` ownership:

| Directory | Purpose |
|-----------|---------|
| `/.data/discobot` | Base home directory (copied from /home/discobot template) |
| `/.data/discobot/workspace` | Cloned repository or empty workspace |
| `/.data/.overlayfs/{SESSION_ID}/upper` | OverlayFS writable layer (new sessions) |
| `/.data/.overlayfs/{SESSION_ID}/work` | OverlayFS scratch space (new sessions) |
| `/.data/.agentfs` | AgentFS SQLite databases (existing sessions) |

Note: Session and message persistence files are stored in `/home/discobot/.config/discobot/` which is managed by the overlay filesystem and created by agent-api on demand.

## Error Handling

Each setup step is wrapped in error handling:

```go
func run() error {
    if err := setupBaseHome(userInfo); err != nil {
        return fmt.Errorf("base home setup failed: %w", err)
    }

    if err := setupWorkspace(...); err != nil {
        return fmt.Errorf("workspace setup failed: %w", err)
    }

    // ... more steps ...

    return runAgent(...)
}
```

If any step fails:
- Error is logged to stderr
- Process sleeps to allow debugging via docker exec
- Container shows as running but not functional

## Testing

### Unit Testing

The core functions can be unit tested:
- `lookupUser()` - user resolution
- `buildChildEnv()` - environment construction
- `reapChildren()` - zombie collection (with mock syscalls)

### Integration Testing

```bash
# Test full startup sequence
docker run --rm \
    --cap-add SYS_ADMIN \
    --device /dev/fuse:/dev/fuse:rwm \
    -e SESSION_ID=test123 \
    -e WORKSPACE_PATH=https://github.com/octocat/Hello-World \
    -v /tmp/data:/.data \
    discobot

# Verify filesystem layout
docker exec -u discobot <container> ls -la /home/discobot /workspace

# Test copy-on-write
docker exec -u discobot <container> touch /home/discobot/workspace/test.txt
docker exec -u discobot <container> ls /.data/discobot/workspace/  # Should NOT have test.txt

# Test signal handling
docker run --rm -d --name test-agent \
    --cap-add SYS_ADMIN \
    --device /dev/fuse:/dev/fuse:rwm \
    -e SESSION_ID=test123 \
    discobot
docker stop test-agent  # Should exit cleanly
```

### Manual Testing

```bash
# Build and test locally
go build -o discobot-agent ./agent/cmd/agent

# Test user lookup
AGENT_USER=$USER SESSION_ID=test ./discobot-agent --help

# Test as PID 1 (requires root)
sudo unshare -p -f --mount-proc ./discobot-agent
```

## Container Requirements

The container requires `CAP_SYS_ADMIN` for both OverlayFS and FUSE mounts:

```yaml
cap_add:
  - SYS_ADMIN
devices:
  - /dev/fuse:/dev/fuse:rwm  # Only needed for AgentFS fallback
```

OverlayFS is kernel-native and doesn't require FUSE. The `/dev/fuse` device is only needed for AgentFS fallback support.

The Dockerfile must include (for AgentFS):
```dockerfile
RUN echo 'user_allow_other' >> /etc/fuse.conf
```

## Future Enhancements

### Health Checks

Could add HTTP health endpoint for orchestration:
```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    if childRunning {
        w.WriteHeader(http.StatusOK)
    } else {
        w.WriteHeader(http.StatusServiceUnavailable)
    }
})
```

### Metrics

Prometheus metrics for observability:
- `obot_agent_startup_duration_seconds`
- `obot_agent_zombies_reaped_total`
- `obot_agent_shutdown_duration_seconds`

### Workspace Caching

For frequently-used repositories:
- Shared read-only base layer across sessions
- Copy-on-write from shared cache
- Reduced clone time for large repos

## References

- [Linux PID 1 and Init](https://felipec.wordpress.com/2013/11/04/init/)
- [Docker and PID 1](https://blog.phusion.nl/2015/01/20/docker-and-the-pid-1-zombie-reaping-problem/)
- [Tini - A tiny init](https://github.com/krallin/tini)
- [Go syscall.SysProcAttr](https://pkg.go.dev/syscall#SysProcAttr)
- [AgentFS Documentation](https://github.com/tursodatabase/agentfs)
