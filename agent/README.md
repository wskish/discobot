# Octobot Agent - Container Init Process

The `octobot-agent` binary is a minimal PID 1 init process for container environments. It handles workspace initialization, AgentFS setup, and process management for Octobot containers.

## Features

- **Home Directory Setup**: Copies `/home/octobot` to persistent storage on first run
- **Workspace Cloning**: Clones git repositories to persistent storage with atomic staging
- **AgentFS Integration**: Initializes and mounts copy-on-write filesystem directly over `/home/octobot`
- **PID 1 Process Reaping**: Collects zombie processes to prevent resource leaks
- **User Switching**: Drops privileges from root to the `octobot` user
- **Signal Forwarding**: Forwards SIGTERM, SIGINT, SIGQUIT, and SIGHUP to child processes
- **Pdeathsig Support**: Ensures child processes die when the init process terminates
- **Graceful Shutdown**: 10-second timeout for clean shutdown before force-killing children

## Startup Sequence

```
1. Copy /home/octobot to /.data/octobot (if not exists)
2. Clone workspace to /.data/octobot/workspace (if WORKSPACE_PATH set)
3. Initialize AgentFS database (if not exists)
4. Mount AgentFS over /home/octobot with -a --allow-root
5. Create /workspace symlink to /home/octobot/workspace
6. Run octobot-agent-api as octobot user
```

## Usage

The agent is typically invoked as the container's CMD:

```bash
# Container starts with required environment variables
docker run -e SESSION_ID=abc123 -e WORKSPACE_PATH=https://github.com/user/repo octobot
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SESSION_ID` | Yes | - | Unique session identifier for AgentFS database |
| `WORKSPACE_PATH` | No | - | Git URL or local path to clone |
| `WORKSPACE_COMMIT` | No | - | Specific commit SHA to checkout |
| `AGENT_BINARY` | No | `/opt/octobot/bin/octobot-agent-api` | Path to the agent API binary |
| `AGENT_USER` | No | `octobot` | Username to run the agent API as |

## Filesystem Layout

### Persistent Storage (/.data volume)

```
/.data/
├── octobot/                     # Base home directory (copied from /home/octobot)
│   ├── .bashrc                  # User shell config
│   ├── .profile                 # User profile
│   └── workspace/               # Cloned repository
└── .agentfs/
    └── {SESSION_ID}.db          # AgentFS SQLite database
```

### System Paths

After setup, the filesystem is configured as:

| System Path | Source | Description |
|-------------|--------|-------------|
| `/home/octobot` | AgentFS mount | COW overlay of `/.data/octobot` |
| `/workspace` | Symlink | Points to `/home/octobot/workspace` |

The AgentFS mount provides copy-on-write semantics - reads come from the base layer (`/.data/octobot`), writes are captured in the SQLite database.

## Building

The agent is built as part of the Docker multi-stage build:

```bash
# Build just the agent binary
go build -o octobot-agent ./agent/cmd/agent

# Or via Docker (as part of full build)
docker build -t octobot .
```

## Architecture

```
Container Start (root)
        │
        ▼
┌───────────────────┐
│   octobot-agent      │  ← PID 1 (runs as root)
│   (init process)  │
│                   │
│   1. Copy home    │
│   2. Clone repo   │
│   3. Init AgentFS │
│   4. Mount AgentFS│
│   5. Create symlink│
└─────────┬─────────┘
          │
          │  fork + setuid(octobot)
          ▼
┌───────────────────┐
│ octobot-agent-api    │  ← Child process (runs as octobot)
│ (agent API)       │
│                   │
│ Sees:             │
│ /home/octobot(COW)│
│ /workspace (link) │
└───────────────────┘
```

### Signal Flow

```
SIGTERM/SIGINT → octobot-agent → forwards to child process group
                      │
                      └→ Waits up to 10s for graceful shutdown
                      └→ Force-kills child if timeout exceeded
```

### Process Reaping

As PID 1, `octobot-agent` is responsible for calling `wait()` on orphaned processes. This prevents zombie process accumulation when child processes fork and their parents exit.

## AgentFS Mount Flags

The AgentFS mount uses special flags:

- `-a`: Auto-unmount when the process exits
- `--allow-root`: Allow root to access the FUSE mount (required for `docker exec` as root)

## Documentation

- [Architecture](./docs/ARCHITECTURE.md) - Technical architecture overview
- [Init Design](./docs/design/init.md) - Detailed design of the init process

## Related Components

- [Agent API](../agent-api/README.md) - The TypeScript/Bun API service that runs as the child process
- [Proxy](../proxy/README.md) - HTTP/SOCKS5 proxy for credential injection
