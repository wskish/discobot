# SSH Module Design

The SSH module provides an SSH server that routes connections to sandbox containers, enabling VS Code Remote SSH and other SSH-based workflows.

## Overview

The SSH server uses the SSH username as a session ID to identify which sandbox container to route the connection to. This allows tools like VS Code Remote SSH to connect directly to sandbox sessions without additional configuration.

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           SSH Server                 │
                    │         (port 3333)                  │
                    └─────────────────┬───────────────────┘
                                      │
                    ┌─────────────────┴───────────────────┐
                    │       Session Handler                │
                    │   (username = session ID)            │
                    └─────────────────┬───────────────────┘
                                      │
         ┌────────────────────────────┼────────────────────────────┐
         │                            │                            │
         ▼                            ▼                            ▼
┌─────────────────┐      ┌─────────────────────┐      ┌─────────────────┐
│   Shell/Exec    │      │       SFTP          │      │  Port Forward   │
│                 │      │                     │      │   (planned)     │
│ Provider.Attach │      │ Provider.ExecStream │      │                 │
│ Provider.Exec   │      │ (sftp-server)       │      │                 │
└────────┬────────┘      └──────────┬──────────┘      └─────────────────┘
         │                          │
         └────────────┬─────────────┘
                      ▼
         ┌────────────────────────┐
         │    Sandbox Provider    │
         │   (Docker/VZ/Mock)     │
         └────────────────────────┘
```

## Components

### Server (`server.go`)

The main SSH server component that:
- Listens for incoming SSH connections
- Performs SSH handshake with clients
- Validates session ID (username) against running sandboxes
- Dispatches channel requests to session handlers

Key types:
- `Config` - Server configuration (address, host key path, provider)
- `Server` - Main server struct with Start/Stop methods
- `sessionHandler` - Handles channels for a specific session

### Session Handler

Handles SSH channels for a validated session:

| Channel Type | Handler | Description |
|--------------|---------|-------------|
| `session` | `handleSessionChannel` | Shell, exec, and subsystem requests |
| `direct-tcpip` | `handleDirectTCPIP` | TCP port forwarding via socat |

### Request Types

Within a session channel, the handler processes:

| Request Type | Method | Description |
|--------------|--------|-------------|
| `shell` | `runShell` | Interactive shell via `Provider.Attach` |
| `exec` | `runExec` | Single command via `Provider.Exec` |
| `subsystem` | `runSFTP` | SFTP via `Provider.ExecStream` with sftp-server |
| `pty-req` | - | PTY allocation (stored for shell/exec) |
| `env` | - | Environment variables (passed to sandbox) |
| `window-change` | - | Terminal resize |

## Data Flow

### Shell Session

```
1. Client opens session channel
2. Client sends pty-req (optional)
3. Client sends shell request
4. Server calls Provider.Attach() with PTY options
5. Bidirectional I/O between SSH channel and PTY
6. Server sends exit-status when PTY closes
```

### Command Execution

```
1. Client opens session channel
2. Client sends exec request with command
3. Server calls Provider.Exec() with command
4. Server writes stdout/stderr to channel
5. Server sends exit-status
```

### SFTP Session

```
1. Client opens session channel
2. Client sends subsystem request "sftp"
3. Server calls Provider.ExecStream() with sftp-server
4. Bidirectional I/O between SSH channel and sftp-server
5. Connection closes when client disconnects
```

### Port Forwarding (direct-tcpip)

```
1. Client opens direct-tcpip channel with destination host:port
2. Server calls Provider.ExecStream() with socat
3. socat connects to destination inside container network
4. Bidirectional I/O between SSH channel and socat
5. Connection closes when either end disconnects
```

This enables SSH local port forwarding (`ssh -L`) to access services running inside the sandbox container.

## Provider Interface Extensions

The SSH module required adding `ExecStream` to the sandbox Provider interface:

```go
// ExecStream runs a command with bidirectional streaming I/O (no TTY).
// Unlike Exec, this doesn't buffer output - it provides direct streaming access.
// Unlike Attach, this doesn't allocate a PTY, so binary data is not corrupted.
ExecStream(ctx context.Context, sessionID string, cmd []string, opts ExecStreamOptions) (Stream, error)
```

The `Stream` interface provides:
- `Read(p []byte) (int, error)` - Read from command output
- `Write(p []byte) (int, error)` - Write to command stdin
- `CloseWrite() error` - Signal EOF to stdin
- `Close() error` - Terminate the stream
- `Wait(ctx) (int, error)` - Wait for exit code

## Authentication

The SSH server uses a "no auth" model where:
- The username is the session ID
- No password or key authentication is performed
- Session ID is validated against running sandboxes

This is secure because:
1. The SSH server typically runs on localhost or internal network
2. Session IDs are UUIDs that are difficult to guess
3. The sandbox must exist and be running to accept connections

For production deployments, additional authentication can be added.

## User Identity

Commands executed via SSH run as the sandbox's default user, not root:
1. On connection, the server queries the sandbox's `/user` endpoint via `UserInfoFetcher`
2. Returns the default UID:GID (e.g., `1000:1000`) for the sandbox
3. All commands (shell, exec, SFTP, port forwarding) run as this user
4. Falls back to root if user info cannot be fetched

## Host Key Management

The server automatically manages SSH host keys:

1. On startup, checks `SSH_HOST_KEY_PATH` for existing key
2. If found, loads and uses the existing key
3. If not found, generates a new 4096-bit RSA key
4. Key is persisted to disk for consistent host identification

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `SSH_ENABLED` | `true` | Enable SSH server |
| `SSH_PORT` | `3333` | Port to listen on |
| `SSH_HOST_KEY_PATH` | `./ssh_host_key` | Host key file path |

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Unknown session ID | Connection closed after handshake |
| Sandbox not running | Connection closed after handshake |
| Sandbox stops during session | Channels close, client disconnects |
| sftp-server not installed | SFTP subsystem fails |
| socat not installed | Port forwarding fails |

## Testing

Unit tests in `server_test.go` cover:
- Server creation and configuration
- Host key generation and persistence
- Connection acceptance for valid sessions
- Connection rejection for invalid sessions
- Request parsing functions

Integration tests in `integration/ssh_test.go` cover:
- Full SSH client connection flow
- Multiple concurrent connections
- Session validation scenarios
- Host key persistence across restarts

## Dependencies

- `golang.org/x/crypto/ssh` - SSH protocol implementation
- `github.com/obot-platform/octobot/server/internal/sandbox` - Sandbox provider interface

### Container Requirements

The sandbox container must have these binaries installed:
- `openssh-sftp-server` - Required for SFTP subsystem (VS Code file operations)
- `socat` - Required for port forwarding (`ssh -L`)

## Future Enhancements

1. **Remote Port Forwarding** - Implement `tcpip-forward` for reverse tunnels (`ssh -R`)
2. **Public Key Auth** - Optional public key authentication for additional security
3. **Session Limits** - Limit concurrent SSH connections per session
4. **Audit Logging** - Log SSH commands and file operations
5. **X11 Forwarding** - Support X11 forwarding for GUI applications
