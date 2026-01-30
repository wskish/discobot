# Discobot - IDE Chat Interface

Discobot is an IDE-like chat interface for managing coding sessions with AI agents. It provides a web-based development environment that lets users interact with AI coding assistants (Claude Code, Gemini CLI, etc.) within isolated workspaces.

## Features

- **Workspaces**: Manage local folders or git repositories as workspaces
- **Sessions**: Create chat threads with AI agents within workspaces
- **Multiple AI Agents**: Configure and switch between different AI coding agents
- **File Diff Viewer**: View and navigate file changes with tabbed browser
- **Integrated Terminal**: xterm.js-based terminal for command execution
- **Theme Support**: Light and dark mode with theme-aware icons
- **Real-time Updates**: SSE-based live updates for session status

## Tech Stack

- **Framework**: React Router 7 + Vite
- **Language**: TypeScript 5.9
- **Styling**: Tailwind CSS v4 with CSS custom properties
- **UI Components**: shadcn/ui (Radix primitives)
- **AI SDK**: Vercel AI SDK v5
- **State Management**: SWR for data fetching and caching
- **Terminal**: xterm.js v6

## Project Structure

This is a monorepo with three main components:

```
.
├── src/                    # React frontend (UI)
├── components/             # React components
├── lib/                    # Shared utilities and hooks
├── agent/                  # Container init process (Go)
├── agent-api/              # Container agent API service (TypeScript/Bun)
├── server/                 # Go backend server
├── proxy/                  # HTTP/SOCKS5 proxy with header injection (Go)
└── docs/                   # Documentation
```

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - Overall system architecture
- [UI Architecture](./docs/ui/ARCHITECTURE.md) - Frontend architecture
- [UI Design Documents](./docs/ui/design/) - UI module designs
- [Server Documentation](./server/README.md) - Go backend
- [Agent Documentation](./agent/README.md) - Container init process
- [Agent API Documentation](./agent-api/README.md) - Container agent API service
- [Proxy Documentation](./proxy/README.md) - HTTP/SOCKS5 MITM proxy

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm
- Go 1.25+
- Docker (for container runtime)

### Development

```bash
# Install dependencies
pnpm install

# Run all services (frontend + backend + agent watcher)
pnpm dev

# Run individual services
pnpm dev:vite    # Vite frontend only
pnpm dev:server  # Go backend with air (auto-reload)
pnpm dev:agent   # Agent watcher
```

### Environment Variables

#### Frontend Environment Variables

Create a `.env.local` file in the root directory (see `.env.local.example`):

```bash
# Copy the example file
cp .env.local.example .env.local

# The REACT_DEVTOOLS_URL is already set in the example
# Uncomment or modify as needed
```

#### Server Environment Variables

Create a `.env` file in the `server/` directory:

```bash
# Database (optional, defaults to SQLite)
DATABASE_URL=postgres://user:pass@localhost:5432/discobot

# Encryption key for credentials
ENCRYPTION_KEY=your-32-byte-key

# OAuth providers (optional)
ANTHROPIC_CLIENT_ID=...
ANTHROPIC_CLIENT_SECRET=...
```

### Building & Checking

```bash
# Build Vite frontend
pnpm build

# Type checking
pnpm typecheck

# Linting and formatting
pnpm check
pnpm check:fix    # Auto-fix issues
```

## Ports

- **3000**: Vite frontend dev server
- **3001**: Go backend server
- **8080**: Agent container endpoint (internal)
- **17080**: Proxy server (HTTP/HTTPS/SOCKS5, inside containers)
- **17081**: Proxy API server (inside containers)

## License

MIT
