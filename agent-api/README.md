# Octobot Agent API

The Octobot Agent API is a Bun-based container service that bridges the IDE chat interface with AI coding agents via the Agent Client Protocol (ACP).

## Overview

The agent runs inside a Docker container alongside the user's workspace. It:
- Exposes an HTTP endpoint for chat messages
- Spawns and manages a Claude Code process via ACP
- Translates between Vercel AI SDK message format and ACP protocol
- Streams responses back to the Go server via SSE

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Docker Container                              │
│                                                                  │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐ │
│  │   Hono      │───▶│   Agent     │───▶│   Claude Code       │ │
│  │   Server    │    │  Interface  │    │   (spawned process) │ │
│  │   :3002     │◀───│ (ACP impl)  │◀───│                     │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│         │                                                        │
│         │ SSE Response                                           │
│         ▼                                                        │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
    Go Server → Frontend
```

The Agent API now uses an `Agent` interface to abstract away the underlying protocol. This allows for different agent implementations beyond ACP (e.g., HTTP-based agents, other protocols).

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - System design and data flow
- [Server Module](./docs/design/server.md) - HTTP API and routing
- [Agent Interface](./docs/design/agent.md) - Agent abstraction layer
- [ACP Module](./docs/design/acp.md) - Agent Client Protocol integration
- [Store Module](./docs/design/store.md) - Session and message storage

## Getting Started

### Prerequisites

- Node.js 20+
- Claude Code ACP binary (`claude-code-acp`)
- Anthropic API key

### Development

```bash
# Install dependencies
npm install

# Run in development (watch mode)
npm run dev

# Run tests
npm test

# Build for production
npm run build
npm start
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | HTTP server port |
| `AGENT_COMMAND` | `claude-code-acp` | Command to spawn agent |
| `AGENT_ARGS` | (empty) | Space-separated arguments |
| `AGENT_CWD` | `process.cwd()` | Working directory for agent |
| `PERSIST_MESSAGES` | `true` | Enable message persistence to disk (set to `false` for agents that replay messages) |
| `SESSION_BASE_DIR` | `/home/octobot/.config/octobot/sessions` | Base directory for per-session storage (creates `{base}/{sessionId}/session.json` and `messages.json`) |

### Docker

```bash
# Build image (from project root)
docker build -t octobot-agent-api .

# Or from agent-api directory
docker build -t octobot-agent-api -f ../Dockerfile ..

# Run container
docker run -p 8080:3002 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v /path/to/workspace:/workspace \
  octobot-agent-api
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

**Migration from older versions:** If you have existing session data from before multi-session support, it will be automatically migrated to the new format on first load. Old files at `/home/octobot/.config/octobot/agent-session.json` and `agent-messages.json` will be moved to `/home/octobot/.config/octobot/sessions/default/` and the old files will be removed.

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
# Run all tests
npm test

# Run with verbose output
npm test -- --verbose

# Run specific test file
npm test -- test/translate.test.ts
```

Integration tests require:
- `claude-code-acp` in PATH
- Valid `ANTHROPIC_API_KEY`

## License

MIT
