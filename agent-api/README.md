# Discobot Agent API

The Discobot Agent API is a Node-based container service that bridges the IDE chat interface with AI coding agents.

## Overview

The agent runs inside a Docker container alongside the user's workspace. It:
- Exposes an HTTP endpoint for chat messages
- Manages Claude Code sessions via the Claude Agent SDK (default) or ACP protocol
- Translates between Vercel AI SDK message format and agent protocol
- Streams responses back to the Go server via SSE
- Automatically persists and resumes sessions from `~/.claude/projects/`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Container                              │
│                                                                  │
│  ┌─────────────┐    ┌─────────────────┐    ┌────────────────┐  │
│  │   Hono      │───▶│     Agent       │───▶│  Claude Agent  │  │
│  │   Server    │    │   Interface     │    │  SDK (default) │  │
│  │   :3002     │◀───│  - ClaudeSDK    │◀───│  or ACP        │  │
│  └─────────────┘    │  - ACPClient    │    └────────────────┘  │
│         │           └─────────────────┘                          │
│         │ SSE Response        │                                  │
│         ▼                     ▼                                  │
│                      ~/.claude/projects/                         │
│                     (session persistence)                        │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
    Go Server → Frontend
```

The Agent API uses an `Agent` interface to abstract the underlying protocol:
- **ClaudeSDKClient** (default): Uses Claude Agent SDK v1 with automatic session persistence
- **ACPClient** (legacy): Spawns Claude Code as a child process via ACP protocol

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - System design and data flow
- [Server Module](./docs/design/server.md) - HTTP API and routing
- [Agent Interface](./docs/design/agent.md) - Agent abstraction layer
- [Claude SDK Module](./docs/design/claude-sdk.md) - Claude Agent SDK integration (default)
- [ACP Module](./docs/design/acp.md) - Agent Client Protocol integration (legacy)
- [Store Module](./docs/design/store.md) - Session and message storage

## Getting Started

### Prerequisites

- Node.js 20+
- Anthropic API key
- Claude Code CLI binary (for local development)
- (Optional) Claude Code ACP binary for legacy mode

**Installing Claude Code CLI (Local Development):**

```bash
# Linux/macOS
curl -fsSL https://claude.ai/install.sh | bash

# Add to PATH (if not already done)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

# Verify installation
claude --version
```

**Note**: The Claude Code CLI is automatically included in the Docker image and does not need to be installed separately when running in containers. The agent-api will automatically discover the CLI binary from:
1. `CLAUDE_CLI_PATH` environment variable (if set)
2. System PATH (searches each directory in `PATH` for `claude` binary)
3. Common installation locations (`~/.local/bin/claude`, `/usr/local/bin/claude`, etc.)

### Development

```bash
# Install dependencies
pnpm install

# Run in development (watch mode)
ANTHROPIC_API_KEY=your-key pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
pnpm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | HTTP server port |
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key for Claude Agent SDK |
| `AGENT_TYPE` | `claude-sdk` | Agent implementation: `claude-sdk` or `acp` |
| `AGENT_MODEL` | `claude-sonnet-4-5-20250929` | Claude model to use (Claude SDK only) |
| `AGENT_CWD` | `process.cwd()` | Working directory for agent |
| `CLAUDE_CLI_PATH` | (auto-discovered) | Path to Claude CLI binary (Claude SDK only) |
| `AGENT_COMMAND` | `claude-code-acp` | Command to spawn agent (ACP mode only) |
| `AGENT_ARGS` | (empty) | Space-separated arguments (ACP mode only) |
| `PERSIST_MESSAGES` | `true` | Enable message persistence (ACP mode only; always enabled for Claude SDK) |
| `SESSION_BASE_DIR` | `/home/discobot/.config/discobot/sessions` | Base directory for per-session storage (ACP mode only) |

**Note**: Claude SDK automatically saves all sessions to `~/.claude/projects/` and cannot be disabled.

### Docker

```bash
# Build image (from project root)
docker build -t discobot-agent-api .

# Or from agent-api directory
docker build -t discobot-agent-api -f ../Dockerfile ..

# Run container
docker run -p 8080:3002 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v /path/to/workspace:/workspace \
  discobot-agent-api
```

## API Endpoints

### Default Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service status |
| GET | `/health` | Health check with ACP status |
| GET | `/chat` | Get all messages (default session) |
| POST | `/chat` | Send message, stream response (default session) |
| DELETE | `/chat` | Clear default session |

### Multi-Session Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/sessions/:id/chat` | Get messages for specific session |
| POST | `/sessions/:id/chat` | Send message to specific session |
| DELETE | `/sessions/:id/chat` | Clear specific session |

The agent API supports multiple independent chat sessions. Each session maintains its own message history and state. The default endpoints (`/chat`) use a session ID of `"default"` for backwards compatibility.

**Migration from older versions:** If you have existing session data from before multi-session support, it will be automatically migrated to the new format on first load. Old files at `/home/discobot/.config/discobot/agent-session.json` and `agent-messages.json` will be moved to `/home/discobot/.config/discobot/sessions/default/` and the old files will be removed.

### POST /chat

Request:
```json
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Hello",
      "parts": [{"type": "text", "text": "Hello"}]
    }
  ]
}
```

Response (SSE):
```
data: {"type": "text-delta", "id": "msg-2", "delta": "Hi"}
data: {"type": "text-delta", "id": "msg-2", "delta": " there!"}
data: {"type": "finish", "messageId": "msg-2"}
```

## Project Structure

```
agent-api/
├── src/
│   ├── index.ts           # Entry point
│   ├── server/
│   │   └── app.ts        # Hono HTTP server
│   ├── agent/
│   │   ├── interface.ts  # Agent abstraction layer
│   │   └── utils.ts      # UIMessage utilities (generateMessageId, createUIMessage)
│   ├── acp/
│   │   ├── client.ts     # ACP client implementation
│   │   └── translate.ts  # ACP-specific type conversions
│   └── store/
│       └── session.ts    # Session storage
├── test/
│   ├── e2e.test.ts       # Integration tests
│   └── *.test.ts         # Unit tests
├── ../Dockerfile         # Multi-stage build (in project root)
├── package.json
└── tsconfig.json
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@agentclientprotocol/sdk` | ACP protocol client |
| `hono` | HTTP framework |
| `@hono/node-server` | Node.js adapter |
| `ai` | Vercel AI SDK types |

## Testing

```bash
# Run all automated tests
pnpm test

# Run with verbose output
pnpm test -- --verbose

# Run specific test file
pnpm test -- test/translate.test.ts

# Run integration tests (requires Claude CLI and API key)
ANTHROPIC_API_KEY=your-key pnpm test test/integration/
```

### Manual Testing

For interactive debugging with detailed logging:

```bash
# Test CLI discovery (no API key needed)
pnpm exec tsx test/manual/cli-discovery.test.ts

# Test tool execution with detailed output
ANTHROPIC_API_KEY=your-key pnpm exec tsx test/manual/tool-execution.test.ts

# Test multiple tool types
ANTHROPIC_API_KEY=your-key pnpm exec tsx test/manual/multiple-tools.test.ts
```

See [test/manual/README.md](./test/manual/README.md) for more details.

### Test Requirements

Integration and manual tests require:
- Claude CLI binary (discovered automatically or via `CLAUDE_CLI_PATH`)
- Valid `ANTHROPIC_API_KEY`
- Tests verify tool execution, input/output capture, and state transitions

## License

MIT
