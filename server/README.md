# Octobot Server

The Octobot Server is a Go backend that provides REST APIs for workspace management, session orchestration, and container lifecycle management.

## Overview

The server handles:
- Workspace creation and git operations
- Session lifecycle and container management
- Agent configuration and credential storage
- Real-time events via Server-Sent Events
- Chat message routing to containers

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       Go Server                                  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    HTTP Handlers                          │  │
│  │  /api/projects/{id}/workspaces, sessions, agents, etc.   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    Service Layer                          │  │
│  │  Business logic, validation, orchestration               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│         ┌─────────────────┼─────────────────┐                   │
│         ▼                 ▼                 ▼                   │
│  ┌────────────┐   ┌────────────┐   ┌────────────────────┐      │
│  │   Store    │   │ Container  │   │   Git Provider     │      │
│  │   (GORM)   │   │  Runtime   │   │   (local git)      │      │
│  └────────────┘   └────────────┘   └────────────────────┘      │
│         │                 │                 │                   │
│         ▼                 ▼                 ▼                   │
│    PostgreSQL/       Docker API       File System               │
│     SQLite                                                      │
└─────────────────────────────────────────────────────────────────┘
```

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - System design and data flow
- [Handler Module](./docs/design/handler.md) - HTTP request handlers
- [Service Module](./docs/design/service.md) - Business logic layer
- [Store Module](./docs/design/store.md) - Data access layer
- [Container Module](./docs/design/container.md) - Docker integration
- [Events Module](./docs/design/events.md) - SSE and event system
- [Jobs Module](./docs/design/jobs.md) - Background job processing

## Getting Started

### Prerequisites

- Go 1.23+
- Docker (for container runtime)
- PostgreSQL or SQLite

### Development

```bash
# Run with auto-reload
cd server
air

# Or run directly
go run cmd/server/main.go

# Run tests
go test ./...

# Run linter
golangci-lint run
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `DATABASE_DSN` | `octobot.db` | Database connection string |
| `AUTH_ENABLED` | `false` | Enable authentication |
| `WORKSPACE_DIR` | `/tmp/workspaces` | Base directory for workspaces |
| `CONTAINER_IMAGE` | `ubuntu:24.04` | Default container image |
| `ENCRYPTION_KEY` | (required) | Key for credential encryption |

### Building

```bash
go build -o octobot-server ./cmd/server
```

## API Endpoints

### Projects

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/{id}` | Get project |
| PUT | `/api/projects/{id}` | Update project |
| DELETE | `/api/projects/{id}` | Delete project |

### Workspaces

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{id}/workspaces` | List workspaces |
| POST | `/api/projects/{id}/workspaces` | Create workspace |
| GET | `/api/projects/{id}/workspaces/{wid}` | Get workspace |
| DELETE | `/api/projects/{id}/workspaces/{wid}` | Delete workspace |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{id}/sessions/{sid}` | Get session |
| PUT | `/api/projects/{id}/sessions/{sid}` | Update session |
| DELETE | `/api/projects/{id}/sessions/{sid}` | Delete session |
| GET | `/api/projects/{id}/sessions/{sid}/messages` | Get messages |

### Chat

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/projects/{id}/chat` | Send chat message (SSE) |

### Agents

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{id}/agents` | List agents |
| POST | `/api/projects/{id}/agents` | Create agent |
| PUT | `/api/projects/{id}/agents/{aid}` | Update agent |
| DELETE | `/api/projects/{id}/agents/{aid}` | Delete agent |
| GET | `/api/projects/{id}/agents/types` | List agent types |

### Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects/{id}/events` | SSE event stream |

## Project Structure

```
server/
├── cmd/server/
│   └── main.go              # Application entry point
├── internal/
│   ├── config/              # Configuration loading
│   ├── database/            # Database connection
│   ├── model/               # GORM models
│   ├── store/               # Data access layer
│   ├── handler/             # HTTP handlers
│   ├── service/             # Business logic
│   ├── container/           # Docker runtime
│   │   ├── docker/          # Docker implementation
│   │   └── mock/            # Mock for testing
│   ├── git/                 # Git operations
│   ├── dispatcher/          # Job dispatcher
│   ├── jobs/                # Background jobs
│   ├── events/              # Event system
│   ├── middleware/          # HTTP middleware
│   ├── encryption/          # Credential encryption
│   └── integration/         # Integration tests
├── go.mod
└── go.sum
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `go-chi/chi` | HTTP routing |
| `gorm.io/gorm` | ORM |
| `docker/docker` | Docker SDK |
| `google/uuid` | UUID generation |
| `gorilla/websocket` | WebSocket support |

## Testing

```bash
# Run all tests
go test ./...

# Run with verbose output
go test -v ./...

# Run specific package
go test ./internal/service/...

# Run integration tests
go test ./internal/integration/...
```

## License

MIT
