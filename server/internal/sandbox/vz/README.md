# VZ Sandbox Provider

The vz package implements VM-based sandboxing for macOS using Apple's Virtualization.framework via the [Code-Hex/vz](https://github.com/Code-Hex/vz) library.

## Architecture

This package provides a **VZ implementation** of the `vm.ProjectVMManager` interface, which allows it to be used alongside other VM providers (KVM, WSL2) in a unified way.

### Components

1. **VzVMManager** (`vz_vm_manager.go`): Implements `vm.ProjectVMManager` interface
   - Manages project-level VMs using Apple Virtualization framework
   - One VM per project, shared across sessions
   - Automatic lifecycle management with idle timeout

2. **VzDockerProvider** (`vz_docker.go`): Implements `sandbox.Provider` interface
   - Hybrid provider combining VMs + Docker containers
   - Uses `vm.ProjectVMManager` interface (not VZ-specific)
   - One container per session inside project VMs
   - VSOCK communication for Docker API access

### VM Abstraction Layer

```
vm.ProjectVMManager (interface)
├── VzVMManager    (Apple Virtualization - macOS)
├── KvmVMManager   (KVM - Linux) [future]
└── WslVMManager   (WSL2 - Windows) [future]

VzDockerProvider uses vm.ProjectVMManager interface
```

This abstraction allows the same Docker-based sandboxing to work across different VM technologies on different platforms.

## Requirements

- macOS 12.0+ (Big Sur or later)
- Apple Silicon or Intel Mac
- Code-signed binary with virtualization entitlement
- Linux kernel (vmlinuz) and optional initrd
- Base disk image (optional, for faster cloning)

## Configuration

### VZ+Docker Provider (Recommended)

```go
// Helper to get XDG-compliant console log directory
func getConsoleLogDir() string {
    stateHome := os.Getenv("XDG_STATE_HOME")
    if stateHome == "" {
        homeDir, _ := os.UserHomeDir()
        stateHome = filepath.Join(homeDir, ".local", "state")
    }
    return filepath.Join(stateHome, "discobot", "vz")
}

// Configure VM settings
vmConfig := vm.Config{
    DataDir:       "/var/lib/discobot/vz",     // VM data directory
    ConsoleLogDir: getConsoleLogDir(),         // Console logs (XDG-compliant)
    KernelPath:    "/path/to/vmlinuz",         // Linux kernel
    InitrdPath:    "/path/to/initrd",          // Initial ramdisk (optional)
    BaseDiskPath:  "/path/to/base-docker.img", // Base disk with Docker (required)
    IdleTimeout:   "30m",                      // Idle timeout before VM shutdown
    CPUCount:      2,                          // CPUs per VM (0 = default)
    MemoryMB:      2048,                       // Memory per VM in MB (0 = default)
}

// Create provider with VM config
provider, err := vz.NewVzDockerProvider(cfg, vmConfig)

// Create sandbox with ProjectID
sandbox, err := provider.Create(ctx, sessionID, sandbox.CreateOptions{
    ProjectID:       "project-123",  // Required - determines VM assignment
    SharedSecret:    "secret",
    WorkspacePath:   "/path/to/workspace",
    WorkspaceSource: "https://github.com/user/repo.git",
})
```

**Key Points:**
- `ProjectID` is required - sessions with the same ID share a VM
- `BaseDiskPath` must point to an image with Docker daemon installed
- `ConsoleLogDir` can be configured for XDG compliance or any custom location
- VMs automatically shut down after `IdleTimeout` of inactivity
- The provider uses `vm.ProjectVMManager` interface, allowing future KVM/WSL2 support

## Architecture Diagram

### VZ+Docker Provider

One VM per project, Docker containers per session:

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Host (macOS)                             │
│                                                                       │
│  ┌─────────────────┐    ┌────────────────────────────────────────┐  │
│  │   Go Server     │    │     VzDockerProvider                    │  │
│  │                 │    │                                          │  │
│  │  HTTPClient ────┼────┼──► Docker client (vsock:2375) ──┐       │  │
│  │                 │    │                                  │       │  │
│  └─────────────────┘    │   ┌──────────────────────────────┼────┐ │  │
│                         │   │     Linux VM (Project-level)  ▼    │ │  │
│                         │   │                                    │ │  │
│                         │   │  socat vsock:2375 ──► Docker sock │ │  │
│                         │   │                           │        │ │  │
│                         │   │  ┌──────────────────┐     │        │ │  │
│                         │   │  │  Docker Daemon   │◄────┘        │ │  │
│                         │   │  └────────┬─────────┘              │ │  │
│                         │   │           │                        │ │  │
│                         │   │  ┌────────┴────────┐   ┌─────────┐│ │  │
│                         │   │  │ Container       │   │Container││ │  │
│                         │   │  │ (Session 1)     │   │(Sess 2) ││ │  │
│                         │   │  │  ┌──────────┐   │   │         ││ │  │
│                         │   │  │  │  Agent   │   │   │ Agent   ││ │  │
│                         │   │  │  │ (Hono)   │   │   │         ││ │  │
│                         │   │  │  └──────────┘   │   │         ││ │  │
│                         │   │  └─────────────────┘   └─────────┘│ │  │
│                         │   │                                    │ │  │
│                         │   └────────────────────────────────────┘ │  │
│                         └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Benefits of VZ+Docker:**
- **Resource Efficiency**: One VM serves multiple sessions in the same project
- **Session Isolation**: Each session gets its own Docker container
- **Faster Session Creation**: Containers start faster than VMs
- **Idle Timeout**: VMs automatically shut down after 30 minutes of inactivity

## Communication

### VZ Provider: Vsock (Host → Guest)

The provider uses virtio-vsock for host-to-guest communication. Since Bun doesn't natively support AF_VSOCK, the agent automatically starts a socat proxy based on the VirtioFS metadata.

**How it works:**
1. Host writes vsock config to metadata: `{"agent": {"vsock": {"port": 3002}}}`
2. Agent reads metadata on startup
3. Agent spawns: `socat VSOCK-LISTEN:3002,reuseaddr,fork TCP:127.0.0.1:3002`
4. Agent starts HTTP server on TCP port 3002
5. Host connects via vsock:3002 → socat → TCP:3002

The Go server connects via vsock:

```go
client, err := provider.GetHTTPClient(ctx, sessionID)
resp, err := client.Get("http://localhost/api/health")
```

The agent handles socat automatically - no manual setup required in the VM init script.

### VZ+Docker Provider: Vsock → Docker → Containers

The VZ+Docker provider uses a two-layer communication approach:

1. **Host → Docker Daemon (via VSOCK)**:
   - Host connects to vsock:2375
   - Socat in VM forwards to Docker socket: `socat VSOCK-LISTEN:2375 → /var/run/docker.sock`
   - Docker client in host uses VSOCK transport

2. **Docker Daemon → Containers**:
   - Standard Docker networking (bridge mode)
   - Each container gets its own network namespace
   - Containers expose port 3002 internally

**Communication Flow:**
```
Host → vsock:2375 → socat → /var/run/docker.sock → Docker → Container:3002 → Agent
```

The provider handles all of this automatically:

```go
// VzDockerProvider creates Docker client with VSOCK transport internally
client, err := provider.GetHTTPClient(ctx, sessionID)
resp, err := client.Get("http://localhost/api/health")
```

### VirtioFS (Metadata Sharing)

Metadata is shared via VirtioFS, mounted read-only in the guest:

```bash
# In VM init script
mkdir -p /run/discobot/metadata
mount -t virtiofs discobot-meta /run/discobot/metadata
```

The agent reads configuration from `/run/discobot/metadata/metadata.json`:

```json
{
  "session_id": "abc123",
  "secret": "salt:hash",
  "workspace": {
    "path": "/path/or/git-url",
    "commit": "abc123",
    "mount_point": "/.workspace.origin"
  },
  "agent": {
    "command": "claude-code-acp",
    "args": [],
    "port": 3002
  }
}
```

## VM Disk Configuration

Each project VM uses a **dual-disk setup**:

1. **Root Disk** (`/dev/vda`) - Read-only
   - Cloned from base image (SquashFS format)
   - Contains OS, Docker, and base software
   - Mounted read-only (`ro` kernel parameter)
   - Path: `{DataDir}/project-{projectID}.img`

2. **Data Disk** (`/dev/vdb`) - Read-write
   - Persistent storage for Docker volumes, containers, etc.
   - Created once per project (20GB default)
   - Survives VM restarts
   - Path: `{DataDir}/project-{projectID}-data.img`

**Benefits:**
- Base image remains pristine (can be updated/replaced)
- All persistent data goes to data disk
- Fast VM creation (base disk is never modified)

## Console Logging

VM console output is logged to a configurable directory:

```
{ConsoleLogDir}/project-{projectID}/console.log
```

**Configuration Example (XDG-compliant):**
```go
stateHome := os.Getenv("XDG_STATE_HOME")
if stateHome == "" {
    homeDir, _ := os.UserHomeDir()
    stateHome = filepath.Join(homeDir, ".local", "state")
}
vmConfig.ConsoleLogDir = filepath.Join(stateHome, "discobot", "vz")
// Results in: ~/.local/state/discobot/vz/project-{projectID}/console.log
```

Console logs include:
- Kernel boot messages
- Init system output
- Docker daemon startup
- Any other VM console output

Logs are appended across VM restarts. The directory is automatically created if it doesn't exist.

## VM Image Requirements

The base disk image must include:

1. **Linux kernel** with virtio drivers:
   - `virtio_blk` - Block devices (for both root and data disks)
   - `virtio_net` - Networking
   - `virtio_console` - Serial console
   - `vsock` - Virtio socket

2. **Docker Engine**:
   - `docker` daemon and CLI
   - Configured to store data on `/dev/vdb` (data disk)
   - Docker socket at `/var/run/docker.sock`

3. **VSOCK-to-Docker bridge**:
   - `socat` to expose Docker socket via VSOCK port 2375
   - Must be started in init system

4. **Init system** that:
   - Mounts data disk (`/dev/vdb`) at appropriate location (e.g., `/var/lib/docker`)
   - Starts Docker daemon (pointing to data disk)
   - Starts socat bridge for Docker socket

### Example Init Script

```bash
#!/bin/sh
set -e

# Mount data disk (/dev/vdb) for persistent Docker data
# Create filesystem on first boot if needed
if ! blkid /dev/vdb; then
  mkfs.ext4 -L docker-data /dev/vdb
fi

mkdir -p /var/lib/docker
mount /dev/vdb /var/lib/docker

# Start Docker daemon (data goes to /var/lib/docker on data disk)
dockerd --data-root=/var/lib/docker &

# Wait for Docker to be ready
until docker info >/dev/null 2>&1; do
  sleep 1
done

echo "Docker is ready"

# Bridge Docker socket to VSOCK port 2375
# This allows the host to connect to Docker via vsock:2375
socat VSOCK-LISTEN:2375,reuseaddr,fork UNIX-CONNECT:/var/run/docker.sock &

echo "VSOCK bridge started on port 2375"

# Keep init process running
wait
```

**Image Recommendations:**
- Alpine Linux or similar minimal distribution
- **SquashFS format** for the root filesystem (read-only, compressed)
- Pre-installed Docker engine and socat
- Minimal base image size (< 500MB recommended)
- Docker-in-Docker support (overlayfs, required kernel modules)
- Kernel with SquashFS support (`CONFIG_SQUASHFS=y`)

## State Persistence

VM data is persisted across multiple locations:

### Disk Images (DataDir)
```
{DataDir}/
├── project-{projectID}.img       # Root disk (read-only, cloned from base)
└── project-{projectID}-data.img  # Data disk (read-write, persistent)
```

### Console Logs (ConsoleLogDir)
```
{ConsoleLogDir}/
└── project-{projectID}/
    └── console.log               # VM console output
```

Example with XDG compliance: `~/.local/state/discobot/vz/project-{projectID}/console.log`

### Lifecycle
On server restart:
- VMs don't survive process death (they're stopped)
- Disk images persist (both root and data)
- Console logs are appended (not truncated)
- VMs can be restarted with same data disk

## Code Signing

The binary must be signed with virtualization entitlements:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.virtualization</key>
  <true/>
</dict>
</plist>
```

```bash
codesign --entitlements vz.entitlements -s - ./discobot-server
```

## Limitations

- **macOS only** - Uses Apple Virtualization.framework
- **No live migration** - VMs die when server process exits
- **No GPU passthrough** - CPU-only workloads
- **vsock proxy required** - Bun doesn't support AF_VSOCK natively
