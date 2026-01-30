# Discobot Go API Implementation Plan

This document outlines the plan to replace the mock TypeScript API with a full Go backend.

## Progress Summary

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | ✅ Complete | Foundation - Go project, config, database setup |
| Phase 2 | ✅ Complete | Database schema, models, GORM store |
| Phase 3 | ✅ Complete | Authentication system (OAuth, sessions) |
| Phase 4 | ✅ Complete | Projects & membership (multi-tenancy) |
| Phase 5 | ✅ Complete | Core resources (workspaces, sessions, agents) |
| Phase 6 | ✅ Complete | AI provider credentials (encryption, OAuth flows) |
| Phase 7 | ✅ Complete | Git integration (interface + local provider) |
| Phase 8 | 🔲 Not Started | Docker terminal (WebSocket PTY) |
| Phase 9 | 🔲 Not Started | AI chat streaming |
| Phase 10 | 🔲 Not Started | Frontend integration |
| Phase 11 | 🔲 Not Started | DevOps (Docker, CI/CD) |

## Phase Details

### Phase 1: Foundation ✅
- Go project structure with `cmd/server` and `internal/` packages
- Configuration loading from environment variables
- Chi router setup with middleware (CORS, logging, recovery)
- Health endpoint

### Phase 2: Database ✅
- GORM ORM with PostgreSQL and SQLite support
- Models: User, UserSession, Project, ProjectMember, ProjectInvitation, Workspace, Session, Agent, AgentMCPServer, Message, Credential, TerminalHistory
- Store layer with all CRUD operations
- Auto-migrations on startup

### Phase 3: Authentication ✅
- GitHub and Google OAuth providers
- Session-based auth with secure cookies
- Session tokens hashed (SHA256) before storage
- Auth middleware for protected routes
- Anonymous user mode (AUTH_ENABLED=false default)

### Phase 4: Projects ✅
- Project CRUD with slug generation
- ProjectMember with roles (owner, admin, member)
- ProjectInvitation with token-based acceptance
- Project membership middleware

### Phase 5: Core Resources ✅
- Workspaces: CRUD, linked to projects
- Sessions: CRUD, linked to workspaces and agents
- Agents: CRUD, types endpoint, default agent, MCP server config
- Integration tests (47+ tests, SQLite + PostgreSQL)

### Phase 6: AI Provider Credentials ✅
- AES-256-GCM encryption for credential storage
- Credential CRUD (list, create, get, delete)
- Anthropic OAuth with PKCE
- GitHub Copilot device code flow
- OpenAI Codex OAuth with PKCE

### Phase 7: Git Integration ✅
- Abstracted `git.Provider` interface for future remote implementations
- Local provider with efficient caching (bare repo cache + workspace clones)
- Full git operations: clone, fetch, checkout, status, diff, branches, log
- File operations: tree listing, read/write files at any ref
- Staging and commit with custom author
- Integration tests (10 tests covering all operations)
- API endpoints under `/workspaces/{id}/git/*`

### Phase 8: Docker Terminal 🔲
- WebSocket endpoint for terminal
- Docker container management per workspace
- PTY attachment for interactive shells
- Terminal history persistence

### Phase 9: AI Chat Streaming 🔲
- Messages API (store/retrieve chat history)
- Streaming chat endpoint (Vercel AI SDK compatible)
- Multi-provider support (Anthropic, OpenAI, etc.)
- Tool use / function calling

### Phase 10: Frontend Integration 🔲
- Update Vite/React Router frontend to use Go backend
- Environment-based API URL configuration
- Remove mock data layer
- Ensure all SWR hooks work with real API

### Phase 11: DevOps 🔲
- Dockerfile for Go server
- Docker Compose for full stack
- GitHub Actions CI/CD
- Production configuration

## API Documentation

See `server/api.md` for detailed API documentation including:
- All endpoints with request/response formats
- Environment variables
- Architecture decisions
- Testing instructions
