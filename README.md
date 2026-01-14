# Octobot - IDE Chat Interface

Octobot is an IDE-like chat interface for managing coding sessions with AI agents. It provides a web-based development environment that lets users interact with AI coding assistants (Claude Code, Gemini CLI, etc.) within isolated workspaces.

## Features

- **Workspaces**: Manage local folders or git repositories as workspaces
- **Sessions**: Create chat threads with AI agents within workspaces
- **Multiple AI Agents**: Configure and switch between different AI coding agents
- **File Diff Viewer**: View and navigate file changes with tabbed browser
- **Integrated Terminal**: xterm.js-based terminal for command execution
- **Theme Support**: Light and dark mode with theme-aware icons
- **Real-time Updates**: SSE-based live updates for session status

## Tech Stack

- **Framework**: Next.js 16 (App Router)
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
├── app/                    # Next.js frontend (UI)
├── components/             # React components
├── lib/                    # Shared utilities and hooks
├── agent/                  # Container agent service (TypeScript)
├── server/                 # Go backend server
└── docs/                   # Documentation
```

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md) - High-level system architecture
- [Design Documents](./docs/design/) - Detailed module designs
- [Agent Documentation](./agent/README.md) - Agent service documentation
- [Server Documentation](./server/README.md) - Go backend documentation

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm
- Go 1.23+
- Docker (for container runtime)

### Development

```bash
# Install dependencies
pnpm install

# Run all services (frontend + backend + agent watcher)
pnpm dev

# Run individual services
pnpm dev:next    # Next.js frontend only
pnpm dev:api     # Go backend with air (auto-reload)
pnpm dev:agent   # Agent watcher
```

### Environment Variables

Create a `.env` file in the `server/` directory:

```bash
# Database (optional, defaults to SQLite)
DATABASE_URL=postgres://user:pass@localhost:5432/octobot

# Encryption key for credentials
ENCRYPTION_KEY=your-32-byte-key

# OAuth providers (optional)
ANTHROPIC_CLIENT_ID=...
ANTHROPIC_CLIENT_SECRET=...
```

### Building & Checking

```bash
# Build Next.js frontend
pnpm build

# Type checking
pnpm typecheck

# Linting and formatting
pnpm check
pnpm check:fix    # Auto-fix issues
```

## Ports

- **3000**: Next.js frontend
- **3001**: Go backend server
- **8080**: Agent container endpoint (internal)

## License

MIT
