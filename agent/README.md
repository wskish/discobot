# Octobot Agent

The Octobot Agent is a Node.js container service that bridges the IDE chat interface with AI coding agents via the Agent Client Protocol (ACP).

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
│  │   Hono      │───▶│   ACP       │───▶│   Claude Code       │ │
│  │   Server    │    │   Client    │    │   (spawned process) │ │
│  │   :8080     │◀───│             │◀───│                     │ │
│  └─────────────┘    └─────────────┘    └─────────────────────┘ │
│         │                                                        │
│         │ SSE Response                                           │
│         ▼                                                        │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
    Go Server → Frontend
```

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - System design and data flow
- [Server Module](./docs/design/server.md) - HTTP API and routing
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
| `PORT` | `3001` | HTTP server port |
| `AGENT_COMMAND` | `claude-code-acp` | Command to spawn agent |
| `AGENT_ARGS` | (empty) | Space-separated arguments |
| `AGENT_CWD` | `process.cwd()` | Working directory for agent |
| `SESSION_FILE` | `/tmp/agent-session.json` | Session persistence path |

### Docker

```bash
# Build image
docker build -t octobot-agent .

# Run container
docker run -p 8080:3001 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -v /path/to/workspace:/workspace \
  octobot-agent
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Service status |
| GET | `/health` | Health check with ACP status |
| GET | `/chat` | Get all messages |
| POST | `/chat` | Send message, stream response |
| DELETE | `/chat` | Clear session |

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
agent/
├── src/
│   ├── index.ts           # Entry point
│   ├── server/
│   │   └── app.ts        # Hono HTTP server
│   ├── acp/
│   │   ├── client.ts     # ACP client wrapper
│   │   └── translate.ts  # Type conversions
│   └── store/
│       └── session.ts    # Session storage
├── test/
│   ├── e2e.test.ts       # Integration tests
│   └── translate.test.ts # Unit tests
├── Dockerfile            # Multi-stage build
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
