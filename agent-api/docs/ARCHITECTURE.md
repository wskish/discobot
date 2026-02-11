# Agent API Architecture

This document describes the architecture of the Octobot Agent API service, a Bun application that bridges the IDE with AI coding agents via the Agent Client Protocol (ACP).

## Overview

The agent service runs inside a Docker container and provides:
- HTTP API for the Go server to send chat messages
- ACP client to communicate with Claude Code
- Message format translation between AI SDK and ACP
- Session persistence for recovery

## System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Docker Container                             │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐  │
│   │                    Agent Service (Node.js)                   │  │
│   │                                                              │  │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│   │  │    HTTP      │  │     ACP      │  │     Session      │  │  │
│   │  │   Server     │  │    Client    │  │      Store       │  │  │
│   │  │   (Hono)     │  │              │  │                  │  │  │
│   │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│   │         │                  │                    │           │  │
│   │         │                  │                    │           │  │
│   │         │                  ▼                    │           │  │
│   │         │         ┌──────────────┐              │           │  │
│   │         │         │ Claude Code  │              │           │  │
│   │         │         │  (spawned)   │              │           │  │
│   │         │         └──────────────┘              │           │  │
│   └─────────│──────────────────────────────────────│───────────┘  │
│             │                                       │              │
│             │ HTTP :3002                           │ File         │
│             ▼                                       ▼              │
│        Go Server                 ~/.config/octobot/*.json        │
│                                                                    │
│                         /workspace (bind mount)                    │
└────────────────────────────────────────────────────────────────────┘
```

## Module Documentation

- [Server Module](./design/server.md) - HTTP API implementation
- [ACP Module](./design/acp.md) - Agent Client Protocol client
- [Store Module](./design/store.md) - Session and message storage
- [File System Layout](./design/filesystem.md) - Container paths and mount points
- [Agent Integrations](./design/agent-integrations.md) - Octobot-specific agent integration points

## Data Flow

### Chat Request Flow

```
1. Go Server POST /chat with UIMessage[]
   │
2. HTTP Handler extracts last user message
   │
3. Convert UIMessage parts → ACP ContentBlock[]
   │
4. ACP Client sends prompt to Claude Code
   │
5. Claude Code processes, returns SessionUpdates
   │
6. Convert SessionUpdates → UIMessage parts
   │
7. Stream SSE to Go Server
   │
8. Go Server proxies to Frontend
```

### Message Format Translation

```
                  ┌───────────────────┐
   UIMessage      │                   │     ACP ContentBlock
   (AI SDK)       │   translate.ts    │     (ACP SDK)
                  │                   │
┌─────────────┐   │  ┌─────────────┐  │   ┌─────────────┐
│ TextUIPart  │───┼─▶│   text      │──┼──▶│ {type:text} │
└─────────────┘   │  └─────────────┘  │   └─────────────┘
                  │                   │
┌─────────────┐   │  ┌─────────────┐  │   ┌─────────────┐
│ FileUIPart  │───┼─▶│ resource    │──┼──▶│ {type:      │
│             │   │  │   link      │  │   │  resource_  │
└─────────────┘   │  └─────────────┘  │   │  link}      │
                  │                   │   └─────────────┘
                  └───────────────────┘
```

### Session Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                      Session States                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐ │
│   │   New    │───▶│ Loading  │───▶│ Running  │───▶│  Closed  │ │
│   └──────────┘    └──────────┘    └──────────┘    └──────────┘ │
│                         │                                        │
│                         │ (fail)                                │
│                         ▼                                        │
│                   ┌──────────┐                                  │
│                   │  Resume  │──────────────────────────────────▶│
│                   └──────────┘                                   │
│                         │ (fail)                                │
│                         ▼                                        │
│                   ┌──────────┐                                  │
│                   │   New    │──────────────────────────────────▶│
│                   │ Session  │                                   │
│                   └──────────┘                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Key Components

### HTTP Server (Hono)

- Minimal web framework
- Routes: `/`, `/health`, `/chat` (GET/POST/DELETE)
- SSE streaming for responses
- JSON request/response handling

### ACP Client

- Spawns Claude Code as child process
- Communicates via stdio (ndjson protocol)
- Manages session creation/loading/resumption
- Handles permission requests (auto-approve)
- Routes streaming updates to callbacks

### Type Translation

- `UIMessage` (AI SDK) ↔ `ContentBlock` (ACP)
- `SessionUpdate` (ACP) → `UIPart` (AI SDK)
- Tool call status mapping
- Message ID generation

### Session Store

- In-memory message array
- File-based session persistence
- Recovery on container restart

## Docker Build

Multi-stage build producing multiple binaries:

| Binary | Description | Linking |
|--------|-------------|---------|
| `octobot-agent-api` | Agent API server (glibc) | Dynamic (glibc) |
| `octobot-agent-api.musl` | Agent API server (musl) | Dynamic (musl) |
| `agentfs` | Filesystem tool | Static (musl) |
| `proxy` | HTTP/SOCKS5 proxy | Static (CGO_ENABLED=0) |

**Note**: All binaries except `octobot-agent-api` are fully statically linked. The agent API binary is built with Bun's `--compile` flag, which produces a self-contained executable that still requires libc (either glibc or musl depending on the build environment).

```dockerfile
# Stage 1: Build agentfs (Rust/musl - static)
FROM rust:alpine AS agentfs-builder

# Stage 2: Build proxy (Go - static)
FROM golang:1.25 AS proxy-builder

# Stage 3: Build octobot-agent-api (Bun/glibc - dynamic)
FROM oven/bun:1 AS bun-builder

# Stage 3b: Build octobot-agent-api.musl (Bun/musl - dynamic)
FROM oven/bun:1-alpine AS bun-builder-musl

# Stage 4: Ubuntu runtime
FROM ubuntu:24.04 AS runtime
```

## Environment Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `AGENT_COMMAND` | `claude-code-acp` | Agent binary |
| `AGENT_ARGS` | (empty) | Additional arguments |
| `AGENT_CWD` | `cwd()` | Working directory |
| `SESSION_FILE` | `/home/octobot/.config/octobot/agent-session.json` | Persistence path |
| `MESSAGES_FILE` | `/home/octobot/.config/octobot/agent-messages.json` | Messages persistence path |

## Error Handling

### Connection Errors

- ACP spawn failure: Return 500 with error message
- Session creation failure: Fall back to new session
- Message timeout: Return partial response + error event

### Stream Errors

- ACP disconnect: Close SSE with error event
- Translation error: Log and skip malformed update
- File I/O error: Disable persistence, continue in-memory

## Security Considerations

- Runs as non-root user in container
- No network access except to Claude API
- Workspace mounted read-write
- Session file contains no secrets
- API keys passed via environment

## Performance

- Single-threaded Node.js event loop
- Streaming responses (no buffering)
- In-memory message storage
- Minimal dependencies
