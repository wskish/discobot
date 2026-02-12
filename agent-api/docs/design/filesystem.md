# File System Layout

This document describes the file system layout inside the agent container, including paths, mount points, and directory purposes.

## Files

| File | Description |
|------|-------------|
| `Dockerfile` | Multi-stage build defining the container layout |
| `src/store/session.ts` | Session persistence (uses `/data` paths) |

## Container Layout

```
/
├── .data/                        # Persistent storage (survives container restarts)
│   └── ...                       # Long-term persistent data
│
├── .workspace/                   # Base workspace directory (READ-ONLY)
│   └── ...                       # Original project files
│
├── .data/
│   └── ...                       # Persistent data (AgentFS databases)
│
├── workspace/                    # Project root (WRITABLE)
│   └── ...                       # Working copy of project files
│
├── home/discobot/                 # User home directory (WRITABLE, via AgentFS)
│   ├── .config/discobot/          # Session data storage
│   │   ├── agent-session.json    # Session metadata (SESSION_FILE)
│   │   └── agent-messages.json   # Message history (MESSAGES_FILE)
│   └── ...                       # User config, caches, etc.
│
├── tmp/                          # Temporary storage (WRITABLE)
│   └── ...                       # Ephemeral files
│
├── opt/discobot/bin/
│   ├── discobot-agent-api            # Agent API server binary (Bun standalone, glibc)
│   ├── agentfs                   # AgentFS file system tool (Rust, static)
│   └── proxy                     # MITM proxy (Go, static)
│
└── run/discobot/                  # Runtime directory (VZ only)
    └── metadata/                 # VirtioFS mount for VM metadata
```

## Directory Purposes

### `/.data` - Persistent Storage

The only directory that persists across container restarts and recreation. Used for long-term data that must survive container recreation.

- **Docker:** Mounted as a Docker volume
- **VZ VM:** Mounted as a separate disk image

Permissions: **Writable**

### `/.workspace` - Base Workspace (Read-Only)

The base workspace directory containing the original project files. This is mounted read-only to preserve the original state.

- Contains the pristine copy of the project
- Used as source for `/workspace`
- Agent cannot modify files here

Permissions: **Read-only**

### `/workspace` - Project Root (Writable)

The working directory where Claude Code operates. This is where the agent reads and writes project files.

- Root of the active project
- All file modifications happen here
- Working directory for Claude Code subprocess

Permissions: **Writable**

### `/home/discobot` - User Home (Writable)

Home directory for the non-root `discobot` user (UID 1000).

Used by:
- Claude Code ACP for user-level configuration
- npm/node for package caching
- Shell initialization files
- Tool configuration (`.config/`, `.local/`)

Permissions: **Writable**

### `/home/discobot/.config/discobot` - Session Data Storage (Writable, Persistent via AgentFS)

Writable storage for session data. Persists across container restarts via AgentFS copy-on-write.

| File | Env Variable | Default | Purpose |
|------|--------------|---------|---------|
| `agent-session.json` | `SESSION_FILE` | `/home/discobot/.config/discobot/agent-session.json` | Session ID and metadata |
| `agent-messages.json` | `MESSAGES_FILE` | `/home/discobot/.config/discobot/agent-messages.json` | Message history |

Session file format:
```json
{
  "sessionId": "session-abc123",
  "cwd": "/workspace",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

The directory is created by agent-api on demand when saving session data.

Permissions: **Writable**

### `/tmp` - Temporary Storage (Writable)

Standard temporary directory for ephemeral files. Cleared on container restart.

Used by:
- Temporary build artifacts
- Process communication files
- Short-lived caches

Permissions: **Writable**

### `/opt/discobot/bin` - Discobot Binaries

All Discobot executables are installed here. Added to `$PATH` at runtime.

| Binary | Source | Purpose | Linking |
|--------|--------|---------|---------|
| `discobot-agent-api` | Bun standalone | Agent HTTP server (glibc) | Dynamic (glibc) |
| `agentfs` | Rust (tursodatabase/agentfs) | File system operations with sandboxing | Static |
| `proxy` | Go (proxy module) | MITM proxy for network interception | Static |

**Note:** All binaries except `discobot-agent-api` are fully statically linked. The agent API binary is built with Bun's `--compile` flag, which produces a self-contained executable that still requires glibc.

Permissions: **Read-only** at runtime

### `/run/discobot/metadata` - VM Metadata (VZ only)

VirtioFS mount point for macOS Virtualization.framework VMs.

Used to pass runtime configuration from the host to the VM without network.

## Runtime Permissions Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    Runtime Permissions                           │
├──────────────────────┬──────────────────────────────────────────┤
│  WRITABLE            │  READ-ONLY                               │
├──────────────────────┼──────────────────────────────────────────┤
│  /workspace          │  /.workspace                             │
│  /home/discobot       │  /opt/discobot/bin                        │
│  /tmp                │  /usr, /bin, /lib, etc.                  │
│  /.data              │                                          │
└──────────────────────┴──────────────────────────────────────────┘
```

## Environment Variations

### Docker Container (Default)

```
┌─────────────────────────────────────────────────────────────────┐
│  Docker Container                                                │
│                                                                  │
│  discobot-agent-api      ─────────────  Main process                │
│                                                                  │
│  /.data              ─────────────  Docker volume (persistent)  │
│  /.workspace         ─────────────  Read-only bind mount        │
│  /workspace          ─────────────  Writable project root       │
│  /home/discobot       ─────────────  AgentFS mount (COW)         │
│  /tmp                ─────────────  Writable tmpfs              │
│                                                                  │
│  Network: Bridge or host mode                                    │
└─────────────────────────────────────────────────────────────────┘
```

### VZ Virtual Machine (macOS)

```
┌─────────────────────────────────────────────────────────────────┐
│  VZ Virtual Machine                                              │
│                                                                  │
│  /                   ─────────────  ext4 root disk (READ-ONLY)  │
│                                                                  │
│  /.data              ─────────────  Mounted disk (persistent)   │
│  /.workspace         ─────────────  VirtioFS (read-only)        │
│  /workspace          ─────────────  Writable project root       │
│  /home/discobot       ─────────────  AgentFS mount (COW)         │
│  /tmp                ─────────────  Writable tmpfs              │
│  /run/discobot/meta   ─────────────  VirtioFS for metadata       │
│                                                                  │
│  Network: Virtio-net                                             │
│  Console: Virtio-console                                         │
└─────────────────────────────────────────────────────────────────┘
```

**Note:** In VZ VMs, the root filesystem is read-only. Writable directories (`/data`, `/workspace`, `/home/discobot`, `/tmp`) use tmpfs or overlay mounts.

## User and Permissions

### Container User

| Property | Value |
|----------|-------|
| Username | `discobot` |
| UID | `1000` |
| GID | `1000` |
| Home | `/home/discobot` |
| Shell | `/bin/bash` |

### File Ownership

| Path | Owner | Mode |
|------|-------|------|
| `/opt/discobot/bin/*` | `root:root` | `755` |
| `/home/discobot` | `discobot:discobot` | `755` |
| `/workspace` | `discobot:discobot` | varies |
| `/.data` | `discobot:discobot` | `755` |

### Process Execution

The container runs as non-root (`USER discobot`):

```dockerfile
USER discobot
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/discobot/bin/discobot-agent-api"]
```

The `tini` init process handles:
- Signal forwarding to child processes
- Zombie process reaping
- Clean shutdown

## Runtime Paths

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_FILE` | `/home/discobot/.config/discobot/agent-session.json` | Session persistence |
| `MESSAGES_FILE` | `/home/discobot/.config/discobot/agent-messages.json` | Message persistence |
| `AGENT_CWD` | `/workspace` | Working directory for Claude Code |

### Network Ports

| Port | Protocol | Service |
|------|----------|---------|
| `3002` | HTTP | Agent API (Hono server) |

### Process Spawning

Claude Code is spawned with working directory set to `/workspace`:

```typescript
const child = spawn(agentCommand, agentArgs, {
  cwd: '/workspace',
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe']
})
```

## Storage Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Storage Persistence                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  /.data              ───── PERSISTS ─────▶  Across restarts     │
│  (persistent vol)          (AgentFS databases)                   │
│                                                                  │
│  /.workspace         ───── READ-ONLY ────▶  Original project    │
│  (base workspace)          (preserved)                           │
│                                                                  │
│  /workspace          ───── WRITABLE ─────▶  Lost on restart     │
│  (project root)            (unless synced)                       │
│                                                                  │
│  /home/discobot       ───── PERSISTS ─────▶  Via AgentFS COW     │
│  (user home)               (session data in ~/.config/discobot)   │
│                                                                  │
│  /tmp                ───── WRITABLE ─────▶  Lost on restart     │
│  (temporary)               (ephemeral)                           │
│                                                                  │
│  /opt/discobot/bin    ───── READ-ONLY ────▶  Image layers        │
│  (application)             (rebuilt)                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Future Considerations

### Workspace Synchronization

The `/workspace` directory is writable but ephemeral. Strategies for preserving changes:
- Sync modified files back to host via `/.workspace` overlay
- Git-based change tracking with automatic commits
- File system snapshots before container shutdown

### AgentFS Integration

The `agentfs` binary is available for enhanced file operations:
- Sandboxed file access with permission controls
- Audit logging of file operations
- Rate limiting for file system calls

### Multi-Session Support

Current layout assumes single session per container. Future enhancements:
```
/.data/
├── sessions/
│   ├── {session-id-1}/
│   │   ├── session.json
│   │   └── messages.json
│   └── {session-id-2}/
│       ├── session.json
│       └── messages.json
└── config.json
```
