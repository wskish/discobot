# IDE Chat - Coding Agent Guidelines

This document provides essential context for AI coding agents working on this project.

## Project Overview

IDE Chat is an IDE-like chat interface for managing coding sessions with AI agents. It features:
- Workspaces (local folders or git repos) containing sessions (chat threads)
- Multiple AI agent configurations (Claude Code, OpenCode, Gemini CLI, etc.)
- File diff viewer with tabbed browser
- Integrated terminal (xterm.js)
- Light/dark theme support

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS v4 with CSS custom properties for theming
- **UI Components**: shadcn/ui (Radix primitives)
- **AI SDK**: Vercel AI SDK v5 with custom chat elements
- **State Management**: SWR for data fetching and caching
- **Terminal**: xterm.js with fit addon

## Directory Structure

```
app/
├── api/projects/[projectId]/     # REST API routes (all nested under project)
│   ├── agents/                   # Agent CRUD + /types for supported agents
│   ├── workspaces/               # Workspace CRUD + sessions
│   ├── sessions/                 # Session CRUD + files + messages
│   ├── files/                    # File content with diffs
│   ├── terminal/                 # Terminal execute + history
│   └── suggestions/              # Autocomplete for paths/repos
├── api/chat/                     # AI SDK streaming chat endpoint
├── globals.css                   # Theme tokens and Tailwind config
├── layout.tsx                    # Root layout with providers
└── page.tsx                      # Main IDE layout orchestration

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

All API routes are nested under `/api/projects/[projectId]/`. The project ID is hardcoded to `"local"` in `lib/api-config.ts`:

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

**Panel Layout**: The main page uses a complex panel system with:
- Resizable panels (drag handles via `ResizeHandle`)
- Minimizable/maximizable panels (`PanelControls`)
- Vertical split: diff view on top, chat/terminal on bottom

**State Management in page.tsx**:
- `selectedSession` - Currently active session
- `openTabs` / `activeTabId` - Open file diff tabs
- `showTerminal` - Toggle between chat and terminal
- `diffPanelState` / `bottomPanelState` - Panel min/max state

### Mock Data

The backend currently uses mock data from `lib/mock-db.tsx`. To implement real persistence:
1. Replace the in-memory stores with database calls
2. Keep the same API response shapes
3. The frontend hooks will work without changes

## Best Practices

### When Adding New Features

1. **Define types first** in `lib/api-types.ts`
2. **Create API route** under `app/api/projects/[projectId]/`
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

Chat uses Vercel AI SDK v5:
- Route handler at `/api/chat` uses `streamText` with `DefaultChatTransport`
- Frontend uses `useChat` hook from `ai/react`
- Custom AI elements in `components/ai-elements/` wrap the SDK components

## Common Tasks

### Adding a New Agent Type

1. Add to `agentTypes` array in `app/api/projects/[projectId]/agents/types/route.ts`
2. Include `icons` array with light/dark SVG variants
3. Define `modes` and `models` arrays

### Adding a New API Endpoint

```typescript
// app/api/projects/[projectId]/example/route.ts
import { NextResponse } from "next/server"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params
  // Implementation
  return NextResponse.json({ data })
}
```

### Creating a New Dialog

Follow the pattern in `add-agent-dialog.tsx`:
- Use `Dialog` from shadcn/ui
- Accept `open` and `onOpenChange` props for controlled mode
- Use `editingItem` prop pattern for create/edit dual-purpose

## Testing Considerations

- Mock data covers most UI states
- Toggle `showClosedSessions` to test session filtering
- Switch themes to test icon rendering
- Test panel resize/minimize behaviors
- Test workspace autocomplete with different input patterns

## Known Quirks

1. **ResizeObserver errors**: Suppressed globally via `ResizeObserverFix` component
2. **Terminal resize**: Uses debounced `requestAnimationFrame` to avoid loops
3. **Icon rendering**: SVGs with `currentColor` must be inlined, not used as `<img>`
