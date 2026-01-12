# Octobot Server API Documentation

## Quick Start

```bash
# Install dependencies
go mod download

# Run with SQLite (simplest - no auth, no secrets needed)
go run ./cmd/server/main.go

# Run with SQLite + authentication enabled
export AUTH_ENABLED=true
export SESSION_SECRET="your-secret-at-least-32-chars-long"
export ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"  # 64 hex chars = 32 bytes
go run ./cmd/server/main.go

# Run with PostgreSQL
export DATABASE_DSN="postgres://user:pass@localhost:5432/octobot?sslmode=disable"
go run ./cmd/server/main.go
```

Server starts on port 8080 by default (configure with `PORT` env var).

**Default mode (no auth)**: When `AUTH_ENABLED=false` (the default), the server uses an anonymous user and doesn't require login. This is ideal for local development and single-user setups.

## Project Structure

```
server/
├── cmd/server/main.go          # Application entrypoint, router setup
├── internal/
│   ├── config/config.go        # Configuration loading from env vars
│   ├── database/database.go    # GORM database connection and migrations
│   ├── handler/                # HTTP handlers (one file per resource)
│   │   ├── handler.go          # Handler struct, JSON helpers, cookie management
│   │   ├── auth.go             # OAuth login/callback/logout/me
│   │   ├── projects.go         # Project CRUD, members, invitations
│   │   ├── workspaces.go       # Workspace CRUD, session creation
│   │   ├── sessions.go         # Session CRUD, files, messages
│   │   ├── agents.go           # Agent CRUD, types, default agent
│   │   ├── credentials.go      # Credential management (mostly TODO)
│   │   ├── files.go            # File endpoints (TODO)
│   │   ├── terminal.go         # Terminal endpoints (TODO)
│   │   └── chat.go             # AI chat endpoint (TODO)
│   ├── middleware/
│   │   ├── auth.go             # Session validation, user context
│   │   └── project.go          # Project membership validation
│   ├── model/model.go          # All GORM model definitions
│   ├── service/                # Business logic layer
│   │   ├── auth.go             # OAuth, session management, user CRUD
│   │   ├── project.go          # Project business logic
│   │   ├── workspace.go        # Workspace business logic
│   │   ├── session.go          # Session business logic
│   │   └── agent.go            # Agent business logic
│   ├── store/store.go          # Data access layer (all GORM queries)
│   ├── testutil/               # Test helpers
│   │   ├── testutil.go         # Test server, fixtures, HTTP helpers
│   │   └── postgres.go         # PostgreSQL Docker container management
│   ├── oauth/                  # OAuth provider implementations (placeholder)
│   └── websocket/              # WebSocket handling (placeholder)
├── api.md                      # This file
└── go.mod
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 8080 | Server port |
| `DATABASE_DSN` | No | sqlite3://./octobot.db | Database connection string |
| `AUTH_ENABLED` | No | false | Enable authentication (requires OAuth setup) |
| `SESSION_SECRET` | When auth enabled | dev default | Secret for session tokens (min 32 chars) |
| `ENCRYPTION_KEY` | When auth enabled | dev default | 32-byte hex-encoded key for credential encryption |
| `CORS_ORIGINS` | No | http://localhost:3000 | Comma-separated allowed origins |
| `WORKSPACE_DIR` | No | ./workspaces | Directory for workspace files |
| `GITHUB_CLIENT_ID` | No | - | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | No | - | GitHub OAuth client secret |
| `GOOGLE_CLIENT_ID` | No | - | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | - | Google OAuth client secret |

### Anonymous User Mode (Default)

When `AUTH_ENABLED=false` (the default):
- No login is required - all requests use the anonymous user
- A default project is created automatically with ID `00000000-0000-0000-0000-000000000001`
- SESSION_SECRET and ENCRYPTION_KEY use insecure defaults (fine for local dev)
- The `/auth/me` endpoint returns the anonymous user info
- All API endpoints are accessible without authentication

## Architecture Decisions

### Database ORM: GORM (not sqlc)

**Choice**: GORM (gorm.io/gorm) over sqlc

We chose GORM over sqlc because:
- **Single model package**: One set of model structs works for both PostgreSQL and SQLite
- **No code generation**: Models are defined once in `internal/model/model.go`
- **Simpler migrations**: `db.AutoMigrate()` handles schema changes automatically
- **Less boilerplate**: No need to maintain separate SQL files and generated code

sqlc was initially considered but required:
- Separate query files for PostgreSQL and SQLite (different SQL dialects)
- Two generated packages with incompatible types
- Manual type mapping between sqlc types and domain types

**SQLite Driver**: Uses `github.com/glebarez/sqlite` (pure Go, wraps modernc.org/sqlite)
- No CGO required - works in any Go environment
- Same API as standard GORM SQLite driver

**PostgreSQL Driver**: Uses `gorm.io/driver/postgres`

### No Cascading Deletes in Schema

The database schema does NOT use cascading deletes (`ON DELETE CASCADE`). All related record deletion is handled explicitly in application code (`internal/store/store.go`).

**Rationale**:
- Explicit control over what gets deleted
- Easier debugging when things go wrong
- Consistent behavior across database backends
- Ability to add soft-delete or archiving in the future

**Delete order for each entity** (implemented in store.go):
- **Project**: messages → terminal_history → sessions → workspaces → agent_mcp_servers → agents → invitations → credentials → members → project
- **Workspace**: messages → terminal_history → sessions → workspace
- **Session**: messages → terminal_history → session
- **Agent**: agent_mcp_servers → (nullify session.agent_id) → agent

### Authentication Flow

1. User visits `/auth/login/{provider}` (github or google)
2. Server generates OAuth state, stores in cookie, redirects to provider
3. Provider redirects back to `/auth/callback/{provider}` with code
4. Server exchanges code for token, fetches user info
5. Server creates/updates user in DB, creates session
6. Session token stored in `octobot_session` cookie (HttpOnly, 30 days)
7. Session token is hashed (SHA256) before storage in DB

### Multi-tenancy

- All resources belong to a Project
- Users are linked to Projects via ProjectMember (with role: owner/admin/member)
- ProjectMember middleware validates membership on all `/api/projects/{projectId}/*` routes
- Project owners can delete projects, admins can manage members

## Implementation Status

### Fully Implemented ✅
- Health endpoint (`/health`)
- Auth: login, callback, logout, me
- Projects: list, create, get, update, delete
- Project members: list, remove
- Project invitations: create, accept
- Workspaces: list, create, get, update, delete
- Sessions: list, create, get, update, delete
- Agents: list, create, get, update, delete, types, set default
- Integration tests for all above (45 tests, SQLite + PostgreSQL)

### Stub/TODO Endpoints 🚧
- `GET /api/projects/{projectId}/sessions/{sessionId}/files` - Returns `[]`
- `GET /api/projects/{projectId}/sessions/{sessionId}/messages` - Returns `[]`
- `GET /api/projects/{projectId}/files/{fileId}` - Returns 501
- `GET /api/projects/{projectId}/suggestions` - Returns `[]`
- `GET /api/projects/{projectId}/credentials` - Returns `[]`
- `POST /api/projects/{projectId}/credentials` - Returns 501
- `GET /api/projects/{projectId}/credentials/{provider}` - Returns 501
- `DELETE /api/projects/{projectId}/credentials/{provider}` - Returns 501
- `POST /api/projects/{projectId}/credentials/anthropic/authorize` - Returns 501
- `POST /api/projects/{projectId}/credentials/anthropic/exchange` - Returns 501
- `POST /api/projects/{projectId}/credentials/github-copilot/device-code` - Returns 501
- `POST /api/projects/{projectId}/credentials/github-copilot/poll` - Returns 501
- `POST /api/projects/{projectId}/credentials/codex/authorize` - Returns 501
- `POST /api/projects/{projectId}/credentials/codex/exchange` - Returns 501
- `GET /api/projects/{projectId}/terminal/ws` - Returns 501
- `GET /api/projects/{projectId}/terminal/history` - Returns `[]`
- `GET /api/projects/{projectId}/terminal/status` - Returns `{"status":"stopped"}`
- `POST /api/chat` - Returns 501

## API Routes

All API routes require authentication via session cookie (`octobot_session`) unless noted.

### Auth Routes (No Auth Required)

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/auth/login/{provider}` | Initiate OAuth login (github, google) | ✅ |
| GET | `/auth/callback/{provider}` | OAuth callback handler | ✅ |
| POST | `/auth/logout` | Logout and clear session | ✅ |
| GET | `/auth/me` | Get current user info | ✅ |

### Project Routes

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects` | List user's projects | ✅ |
| POST | `/api/projects` | Create new project | ✅ |
| GET | `/api/projects/{projectId}` | Get project details | ✅ |
| PUT | `/api/projects/{projectId}` | Update project (admin+) | ✅ |
| DELETE | `/api/projects/{projectId}` | Delete project (owner only) | ✅ |

### Project Members

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/members` | List project members | ✅ |
| DELETE | `/api/projects/{projectId}/members/{userId}` | Remove member (admin+) | ✅ |
| POST | `/api/projects/{projectId}/invitations` | Create invitation (admin+) | ✅ |
| POST | `/api/projects/{projectId}/invitations/{token}/accept` | Accept invitation | ✅ |

### Workspaces

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/workspaces` | List workspaces | ✅ |
| POST | `/api/projects/{projectId}/workspaces` | Create workspace | ✅ |
| GET | `/api/projects/{projectId}/workspaces/{workspaceId}` | Get workspace with sessions | ✅ |
| PUT | `/api/projects/{projectId}/workspaces/{workspaceId}` | Update workspace | ✅ |
| DELETE | `/api/projects/{projectId}/workspaces/{workspaceId}` | Delete workspace | ✅ |

### Sessions

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/workspaces/{workspaceId}/sessions` | List sessions in workspace | ✅ |
| POST | `/api/projects/{projectId}/workspaces/{workspaceId}/sessions` | Create session | ✅ |
| GET | `/api/projects/{projectId}/sessions/{sessionId}` | Get session | ✅ |
| PUT | `/api/projects/{projectId}/sessions/{sessionId}` | Update session | ✅ |
| DELETE | `/api/projects/{projectId}/sessions/{sessionId}` | Delete session | ✅ |
| GET | `/api/projects/{projectId}/sessions/{sessionId}/files` | Get session files | 🚧 |
| GET | `/api/projects/{projectId}/sessions/{sessionId}/messages` | List messages | 🚧 |

### Agents

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/agents` | List agents | ✅ |
| POST | `/api/projects/{projectId}/agents` | Create agent | ✅ |
| GET | `/api/projects/{projectId}/agents/types` | Get supported agent types | ✅ |
| POST | `/api/projects/{projectId}/agents/default` | Set default agent | ✅ |
| GET | `/api/projects/{projectId}/agents/{agentId}` | Get agent | ✅ |
| PUT | `/api/projects/{projectId}/agents/{agentId}` | Update agent | ✅ |
| DELETE | `/api/projects/{projectId}/agents/{agentId}` | Delete agent | ✅ |

### Credentials

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/credentials` | List credentials | 🚧 |
| POST | `/api/projects/{projectId}/credentials` | Create credential | 🚧 |
| GET | `/api/projects/{projectId}/credentials/{provider}` | Get credential | 🚧 |
| DELETE | `/api/projects/{projectId}/credentials/{provider}` | Delete credential | 🚧 |
| POST | `/api/projects/{projectId}/credentials/anthropic/authorize` | Anthropic PKCE auth | 🚧 |
| POST | `/api/projects/{projectId}/credentials/anthropic/exchange` | Anthropic token exchange | 🚧 |
| POST | `/api/projects/{projectId}/credentials/github-copilot/device-code` | Copilot device flow | 🚧 |
| POST | `/api/projects/{projectId}/credentials/github-copilot/poll` | Copilot poll | 🚧 |
| POST | `/api/projects/{projectId}/credentials/codex/authorize` | Codex PKCE auth | 🚧 |
| POST | `/api/projects/{projectId}/credentials/codex/exchange` | Codex token exchange | 🚧 |

### Terminal

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/api/projects/{projectId}/terminal/ws` | WebSocket terminal | 🚧 |
| GET | `/api/projects/{projectId}/terminal/history` | Get terminal history | 🚧 |
| GET | `/api/projects/{projectId}/terminal/status` | Get terminal status | 🚧 |

### Other

| Method | Path | Description | Status |
|--------|------|-------------|--------|
| GET | `/health` | Health check | ✅ |
| POST | `/api/chat` | AI chat endpoint | 🚧 |

## Testing

### Run All Tests (SQLite)

```bash
go test ./internal/handler/...
```

### Run All Tests (PostgreSQL via Docker)

```bash
TEST_POSTGRES=1 go test ./internal/handler/...
```

This will:
1. Remove any existing `octobot-test-postgres` container
2. Start a fresh PostgreSQL 16 container on port 5433
3. Run all tests
4. On success: remove the container
5. On failure: keep the container for debugging

To connect to a failed test database:
```bash
psql postgres://octobot:octobot@localhost:5433/octobot_test?sslmode=disable
```

To manually remove the container:
```bash
docker rm -f octobot-test-postgres
```

### Test Architecture

- Each test creates a fresh `TestServer` via `testutil.NewTestServer(t)`
- SQLite: Uses in-memory database (`:memory:`), fresh per test
- PostgreSQL: Uses shared container, tables truncated between tests
- Test helpers: `CreateTestUser`, `CreateTestProject`, `CreateTestWorkspace`, `CreateTestSession`, `CreateTestAgent`
- HTTP helpers: `AuthenticatedClient`, `ParseJSON`, `AssertStatus`

## Models

See `internal/model/model.go` for all database models:

| Model | Table | Description |
|-------|-------|-------------|
| User | users | Authenticated users (OAuth) |
| UserSession | user_sessions | Login sessions (token hash stored) |
| Project | projects | Multi-tenant container |
| ProjectMember | project_members | User membership with role |
| ProjectInvitation | project_invitations | Pending invitations with token |
| Agent | agents | AI agent configurations |
| AgentMCPServer | agent_mcp_servers | MCP server configs per agent |
| Workspace | workspaces | Working directories (local/git) |
| Session | sessions | Chat threads within workspace |
| Message | messages | Chat messages in session |
| Credential | credentials | Encrypted AI provider credentials |
| TerminalHistory | terminal_history | Terminal command history |

## Next Steps / TODO

1. **Implement Messages API** - Store and retrieve chat messages for sessions
2. **Implement Credentials API** - Encrypted storage for AI provider tokens
3. **Implement AI Provider OAuth flows**:
   - Anthropic (PKCE flow)
   - GitHub Copilot (device flow)
   - OpenAI/Codex (PKCE flow)
4. **Implement Terminal WebSocket** - Docker PTY attachment for container terminals
5. **Implement File Diff API** - Git integration for showing file changes
6. **Implement Chat endpoint** - AI SDK integration for streaming responses
7. **Add rate limiting middleware**
8. **Add request logging/tracing**

## Gotchas & Notes

1. **Session tokens are hashed** - The actual token is sent to client, SHA256 hash stored in DB
2. **GORM AutoMigrate** - Runs on every startup, only adds columns/tables (doesn't remove)
3. **Foreign keys** - Defined in model but no cascade deletes (handled in store.go)
4. **PostgreSQL test isolation** - Tables are truncated between tests, not dropped
5. **Agent types** - Hardcoded in `handler/agents.go`, not stored in DB
6. **Project slug** - Auto-generated, must be unique (used for URL-friendly identifiers)
