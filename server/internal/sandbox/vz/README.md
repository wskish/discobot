# VZ Sandbox Provider

The vz provider implements the `sandbox.Provider` interface using Apple's Virtualization.framework via the [Code-Hex/vz](https://github.com/Code-Hex/vz) library. It runs sandboxes as lightweight Linux VMs on macOS.

## Requirements

- macOS 12.0+ (Big Sur or later)
- Apple Silicon or Intel Mac
- Code-signed binary with virtualization entitlement
- Linux kernel (vmlinuz) and optional initrd
- Base disk image (optional, for faster cloning)

## Configuration

```go
vzCfg := &vz.Config{
    DataDir:      "/var/lib/octobot/vz",     // VM data directory
    KernelPath:   "/path/to/vmlinuz",         // Linux kernel
    InitrdPath:   "/path/to/initrd",          // Initial ramdisk (optional)
    BaseDiskPath: "/path/to/base.img",        // Base disk to clone (optional)
}

provider, err := vz.NewProvider(cfg, vzCfg)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Host (macOS)                         │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │   Go Server     │    │        VZ Provider               │ │
│  │                 │    │                                   │ │
│  │  HTTPClient ────┼────┼──► vsock:3002 ──┐                │ │
│  │                 │    │                  │                │ │
│  └─────────────────┘    │   ┌─────────────┼────────────┐   │ │
│                         │   │    Linux VM  ▼            │   │ │
│                         │   │                           │   │ │
│                         │   │  socat vsock ──► TCP:3002 │   │ │
│                         │   │                     │     │   │ │
│                         │   │              ┌──────▼───┐ │   │ │
│                         │   │              │  Agent   │ │   │ │
│                         │   │              │ (Hono)   │ │   │ │
│                         │   │              └──────────┘ │   │ │
│                         │   │                           │   │ │
│                         │   │  /run/octobot/metadata    │   │ │
│                         │   │  (VirtioFS mount)         │   │ │
│                         │   └───────────────────────────┘   │ │
│                         └───────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Communication

### Vsock (Host → Guest)

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

### VirtioFS (Metadata Sharing)

Metadata is shared via VirtioFS, mounted read-only in the guest:

```bash
# In VM init script
mkdir -p /run/octobot/metadata
mount -t virtiofs octobot-meta /run/octobot/metadata
```

The agent reads configuration from `/run/octobot/metadata/metadata.json`:

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

## VM Image Requirements

The base disk image should include:

1. **Linux kernel** with virtio drivers:
   - `virtio_blk` - Block devices
   - `virtio_net` - Networking
   - `virtio_console` - Serial console
   - `virtiofs` - VirtioFS filesystem
   - `vsock` - Virtio socket

2. **Userspace tools**:
   - `socat` - For vsock-to-TCP proxy
   - `mount` - For VirtioFS mounting

3. **Init system** that:
   - Mounts VirtioFS at `/run/octobot/metadata`
   - Starts the agent (it handles socat automatically)

### Example Init Script

```bash
#!/bin/sh
set -e

# Mount VirtioFS metadata (agent reads config from here)
mkdir -p /run/octobot/metadata
mount -t virtiofs octobot-meta /run/octobot/metadata || true

# Start agent (it will automatically start socat if vsock is configured)
cd /opt/octobot
exec ./octobot-agent
```

Note: The agent automatically starts socat for vsock forwarding based on the metadata configuration. No manual socat setup is needed.

## State Persistence

VM state is persisted to disk:

```
<dataDir>/
├── state/
│   └── <sessionID>.json      # VM metadata (status, timestamps, etc.)
├── metadata/
│   └── <sessionID>/
│       ├── metadata.json     # Full config for VirtioFS
│       ├── session_id        # Plain text session ID
│       └── secret            # Hashed secret (mode 0600)
└── octobot-session-<sessionID>.img  # Disk image
```

On server restart:
- VMs are marked as "stopped" (they don't survive process death)
- Disk images persist and VMs can be restarted
- State files track creation/start/stop timestamps

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
codesign --entitlements vz.entitlements -s - ./octobot-server
```

## Limitations

- **macOS only** - Uses Apple Virtualization.framework
- **No live migration** - VMs die when server process exits
- **No GPU passthrough** - CPU-only workloads
- **vsock proxy required** - Bun doesn't support AF_VSOCK natively
