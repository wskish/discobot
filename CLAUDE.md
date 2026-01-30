# Octobot - Coding Agent Guidelines

This document provides essential context for AI coding agents working on this project.

## Documentation

**IMPORTANT**: When making changes to the codebase, update the relevant documentation files:

### Architecture & Design Docs
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) - Overall system architecture (update when changing system-wide patterns)
- [docs/ui/ARCHITECTURE.md](./docs/ui/ARCHITECTURE.md) - UI architecture (update when changing frontend patterns)
- [docs/ui/design/](./docs/ui/design/) - UI module design docs (layout, chat, data-layer, components, theming)

### Component READMEs
- [server/README.md](./server/README.md) - Go backend documentation
- [agent/README.md](./agent/README.md) - Container init process documentation
- [agent-api/README.md](./agent-api/README.md) - Container agent API documentation
- [proxy/README.md](./proxy/README.md) - MITM proxy documentation

### Agent Design Docs
- [agent/docs/ARCHITECTURE.md](./agent/docs/ARCHITECTURE.md) - Agent init process architecture
- [agent/docs/design/](./agent/docs/design/) - Agent design docs (init process)

### Server Design Docs
- [server/docs/ARCHITECTURE.md](./server/docs/ARCHITECTURE.md) - Server architecture
- [server/docs/design/](./server/docs/design/) - Server module docs (handler, service, store, sandbox, events, jobs)

### Agent API Design Docs
- [agent-api/docs/ARCHITECTURE.md](./agent-api/docs/ARCHITECTURE.md) - Agent API architecture
- [agent-api/docs/design/](./agent-api/docs/design/) - Agent API module docs (server, acp, store)

## Project Overview

Octobot is an IDE-like chat interface for managing coding sessions with AI agents. It features:
- Workspaces (local folders or git repos) containing sessions (chat threads)
- Multiple AI agent configurations (Claude Code, OpenCode, Gemini CLI, etc.)
- File diff viewer with tabbed browser
- Integrated terminal (xterm.js)
- Light/dark theme support

## Tech Stack

- **Package Manager**: pnpm (always use `pnpm` instead of `npm` or `yarn`)
- **Framework**: React Router 7 + Vite
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 with CSS custom properties for theming
- **UI Components**: shadcn/ui (Radix primitives)
- **AI SDK**: Vercel AI SDK v5 with custom chat elements
- **State Management**: SWR for data fetching and caching
- **Terminal**: xterm.js with fit addon

## Directory Structure

```
src/
├── main.tsx                      # Vite entry point with BrowserRouter
├── App.tsx                       # Root component with Routes and providers
├── globals.css                   # Theme tokens and Tailwind config
└── pages/
    └── HomePage.tsx              # Main IDE layout orchestration

components/
├── ai-elements/                  # AI SDK UI wrapper components
│   ├── conversation.tsx          # Chat message list container
│   ├── message.tsx               # Individual message display
│   └── prompt-input.tsx          # Chat input with tools
├── ide/                          # IDE-specific components
│   ├── sidebar-tree.tsx          # Left panel: workspaces + sessions
│   ├── agents-panel.tsx          # Bottom-left: agent list
│   ├── chat-panel.tsx            # Chat interface with mode/model selectors
│   ├── terminal-view.tsx         # xterm.js terminal
│   ├── file-panel.tsx            # Right panel: file tree
│   ├── tabbed-diff-view.tsx      # Center: tabbed file diffs
│   ├── diff-view.tsx             # Single file diff display
│   ├── icon-renderer.tsx         # Theme-aware icon rendering
│   ├── panel-controls.tsx        # Min/max/close buttons
│   ├── resize-handle.tsx         # Draggable panel divider
│   ├── add-agent-dialog.tsx      # Agent create/edit form
│   ├── add-workspace-dialog.tsx  # Workspace creation form
│   └── theme-toggle.tsx          # Light/dark mode toggle
└── ui/                           # shadcn/ui components

lib/
├── api-types.ts                  # Shared TypeScript interfaces
├── api-config.ts                 # PROJECT_ID constant and getApiBase()
├── api-client.ts                 # ApiClient class for REST calls
├── mock-db.tsx                   # In-memory mock database
├── hooks/                        # SWR hooks for each resource
│   ├── use-workspaces.ts
│   ├── use-sessions.ts
│   ├── use-agents.ts
│   ├── use-agent-types.ts
│   ├── use-files.ts
│   ├── use-messages.ts
│   └── use-suggestions.ts
└── utils.ts                      # cn() utility for classnames
```

## Key Patterns

### API Structure

All API routes are nested under `/api/projects/[projectId]/`. The frontend proxies these requests to the Go backend server at `localhost:3001`. The project ID is hardcoded to `"local"` in `lib/api-config.ts`:

```typescript
export const PROJECT_ID = "local"
export function getApiBase() {
  return `/api/projects/${PROJECT_ID}`
}
```

### Data Fetching with SWR

Use the hooks in `lib/hooks/` for data fetching. They provide:
- Automatic caching and revalidation
- Mutation functions that update the cache optimistically
- Loading and error states

```typescript
const { workspaces, isLoading, createWorkspace, deleteWorkspace } = useWorkspaces()
const { agents, createAgent, updateAgent, deleteAgent } = useAgents()
```

### Type Definitions

All shared types are in `lib/api-types.ts`. Key interfaces:

- `Workspace` - Local folder or git repo containing sessions
- `Session` - Chat thread with files, linked to workspace and agent
- `Agent` - Configuration for an AI coding agent
- `SupportedAgentType` - Template with icons, modes, and models
- `FileNode` - Recursive file tree structure with diff content
- `MCPServer` / `MCPServerConfig` - MCP server configuration (stdio or http)
- `Icon` / `Icons` - Theme-aware icon specification

### Theming

The app uses CSS custom properties for theming defined in `globals.css`:

- Standard tokens: `--background`, `--foreground`, `--primary`, etc.
- IDE-specific tokens: `--tree-hover`, `--tree-selected`, `--terminal-bg`, `--diff-add`, etc.

Icons support light/dark themes via the `Icon.theme` property. Use `IconRenderer` component for theme-aware icon display:

```typescript
<IconRenderer icons={agent.icons} size={16} className="..." />
```

### Component Patterns

**Panel Layout**: The HomePage component uses a complex panel system with:
- Resizable panels (drag handles via `ResizeHandle`)
- Minimizable/maximizable panels (`PanelControls`)
- Vertical split: diff view on top, chat/terminal on bottom

**State Management in HomePage.tsx**:
- Uses `MainPanelProvider` context for session/workspace selection
- Panel dimensions managed with `usePersistedState`
- `showTerminal` - Toggle between chat and terminal
- Panel collapse states maintained in local component state

### Mock Data

The backend currently uses mock data from `lib/mock-db.tsx`. To implement real persistence:
1. Replace the in-memory stores with database calls
2. Keep the same API response shapes
3. The frontend hooks will work without changes

## Best Practices

### React Performance

When working on React code (components, hooks, data fetching, etc.), load the Vercel React best practices skill:

```
/vercel-react-best-practices
```

This skill provides 45 optimization rules across categories like eliminating waterfalls, bundle size, SWR patterns, and re-render optimization.

### When Adding New Features

1. **Define types first** in `lib/api-types.ts`
2. **Create backend API route** in `server/` (Go backend handles all API routes)
3. **Add API client method** in `lib/api-client.ts`
4. **Create SWR hook** in `lib/hooks/` if needed
5. **Build UI components** in `components/ide/`

### Styling Guidelines

- Use Tailwind utility classes with design tokens
- Prefer `bg-background`, `text-foreground`, `border-border` over raw colors
- Use IDE tokens for specialized styling: `bg-tree-hover`, `bg-diff-add`
- Keep consistent spacing: `gap-2`, `p-2`, `px-3 py-2` for tree items

### Icon Handling

Icons from API can include multiple variants for light/dark themes:

```typescript
interface Icon {
  src: string           // data: URI or URL
  mimeType?: string     // image/svg+xml, etc.
  sizes?: string[]      // ["48x48", "any"]
  theme?: "light" | "dark"
}
```

SVGs using `currentColor` are rendered inline (not as `<img>`) to inherit text color.

### Terminal Integration

The terminal uses xterm.js with WebSocket-like API compatibility. Commands are sent to `/api/projects/[projectId]/terminal/execute` and return ANSI-formatted output.

### AI Chat Integration

Chat uses Vercel AI SDK v6:
- Route handler at `/api/chat` uses `streamText` with `DefaultChatTransport`
- Frontend uses `useChat` hook from `ai/react`
- Custom AI elements in `components/ai-elements/` wrap the SDK components

## Common Tasks

### Adding a New Agent Type

1. Add to the agent types configuration in the Go backend (`server/`)
2. Include `icons` array with light/dark SVG variants
3. Define `modes` and `models` arrays

### Adding a New API Endpoint

API endpoints are implemented in the Go backend (`server/`). See [Server Documentation](./server/README.md) for details on adding new routes.

### Creating a New Dialog

Follow the pattern in `add-agent-dialog.tsx`:
- Use `Dialog` from shadcn/ui
- Accept `open` and `onOpenChange` props for controlled mode
- Use `editingItem` prop pattern for create/edit dual-purpose

## Testing Considerations

### Frontend Testing

**IMPORTANT**: Use Node's built-in test runner, NOT vitest or jest.

Frontend tests use:
- `node:test` - Node's built-in test runner
- `@testing-library/react` - For rendering and querying components
- `jsdom` - DOM implementation (must be loaded BEFORE React via `--import`)
- `tsx` - TypeScript/JSX transpilation

Run frontend tests with:
```bash
node --import ./test/setup.js --import tsx --test <test-file>
```

The `test/setup.js` file initializes jsdom globals before any React imports. This order is critical.

Example test for re-render performance using React Profiler:
```tsx
import { Profiler } from "react";
const onRender = (id) => { renderCounts[id]++; };
render(<Profiler id="MyComponent" onRender={onRender}><MyComponent /></Profiler>);
```

### Manual Testing

- Mock data covers most UI states
- Toggle `showClosedSessions` to test session filtering
- Switch themes to test icon rendering
- Test panel resize/minimize behaviors
- Test workspace autocomplete with different input patterns

## Known Quirks

1. **ResizeObserver errors**: Suppressed globally via `ResizeObserverFix` component
2. **Terminal resize**: Uses debounced `requestAnimationFrame` to avoid loops
3. **Icon rendering**: SVGs with `currentColor` must be inlined, not used as `<img>`
