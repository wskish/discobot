# Discobot

An AI-powered IDE interface for managing coding sessions with AI agents. Discobot gives you a complete development environment where you can interact with AI coding assistants in isolated, sandboxed workspaces.

> **[▶️ Watch the demo video](#)** *(coming soon)*

## What is Discobot?

Discobot is a web-based platform that lets you:

- **Chat with AI coding agents** to build features, debug issues, and write code
- **Work in isolated sandboxes** where each session runs in its own secure container
- **Use your own IDE** by launching remote sessions directly into sandboxes
- **SSH into environments** for direct access to any sandbox
- **Switch between agents** with support for multiple AI coding assistants

Think of it as your AI coding companion with built-in workspace management, version control integration, and debugging tools.

## Key Features

### 🤖 Multiple Coding Agents
Choose which AI agent to use for each session. Currently supports Claude Code, with OpenCode, Gemini CLI, and others coming soon. Each agent can have different models, modes, and capabilities to match your workflow.

### 📦 Isolated Sandboxed Sessions
Run parallel sessions in secure containers with full app debugging capabilities. Your local files stay safe — changes only apply when you commit them.

### 💻 Use Your Own IDE
Launch remote IDE sessions (VS Code, Cursor, etc.) directly into each sandbox environment. Get the full power of your favorite development tools.

### 🔒 SSH Access to Sandboxes
Direct SSH access to every sandbox environment for advanced debugging and configuration.

### 🛠️ Integrated Lightweight Tools
Built-in terminal, diff viewer, and file editor for quick edits without leaving the interface.

### 🗂️ Workspace Management
Manage local folders or clone git repositories. Each workspace maintains its own sessions and history.

## Documentation

For detailed information about the architecture, setup, and development:

- [Architecture Overview](./docs/ARCHITECTURE.md) - Overall system architecture
- [UI Architecture](./docs/ui/ARCHITECTURE.md) - Frontend architecture
- [Server Documentation](./server/README.md) - Go backend server
- [Agent Documentation](./agent/README.md) - Container init process
- [Agent API Documentation](./agent-api/README.md) - Container agent API service
- [Proxy Documentation](./proxy/README.md) - HTTP/SOCKS5 MITM proxy

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm
- Go 1.25+
- Docker (for container runtime)

### Quick Start

```bash
# Install dependencies
pnpm install

# Run all services (frontend + backend + agent watcher)
pnpm dev
```

This will start:
- Vite frontend at `http://localhost:3000`
- Go backend server at `http://localhost:3001`
- Agent watcher for hot-reload

### Configuration

Create a `.env.local` file in the root directory (see `.env.local.example` for options).

For server configuration, create a `.env` file in the `server/` directory with your API keys and database settings. See [Server Documentation](./server/README.md) for details.

## Contributing

We welcome contributions! Check out our [issues](https://github.com/obot-platform/discobot/issues) to see what features or agent integrations we're working on next.

## License

MIT
