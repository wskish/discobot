# Components Module

This document describes the UI component organization and patterns used throughout the application.

## Files

| Directory | Description |
|-----------|-------------|
| `components/ui/` | shadcn/ui base components |
| `components/ide/` | IDE-specific components |
| `components/ai-elements/` | Vercel AI SDK wrappers |
| `components/theme-provider.tsx` | Theme context provider |
| `components/resize-observer-fix.tsx` | ResizeObserver error suppression |

## Component Categories

### Base UI Components (shadcn/ui)

Located in `components/ui/`, these are Radix-based primitives:

| Component | Usage |
|-----------|-------|
| `button.tsx` | Clickable actions with variants |
| `dialog.tsx` | Modal dialogs |
| `input.tsx` | Text input fields |
| `dropdown-menu.tsx` | Context menus and selectors |
| `select.tsx` | Single-selection dropdowns |
| `tabs.tsx` | Tab navigation |
| `tooltip.tsx` | Hover tooltips |
| `scroll-area.tsx` | Custom scrollbars |
| `separator.tsx` | Visual dividers |
| `badge.tsx` | Status indicators |
| `avatar.tsx` | User/agent avatars |

### IDE Components

Located in `components/ide/`:

#### Workspace Navigation

| Component | Description |
|-----------|-------------|
| `sidebar-tree.tsx` | Expandable workspace/session tree |
| `agents-panel.tsx` | Agent list with selection |
| `file-panel.tsx` | File tree explorer |

#### Content Display

| Component | Description |
|-----------|-------------|
| `chat-panel.tsx` | AI chat interface |
| `terminal-view.tsx` | xterm.js terminal |
| `tabbed-diff-view.tsx` | Multi-file diff tabs |
| `diff-view.tsx` | Single file diff display |

#### Dialogs

| Component | Description |
|-----------|-------------|
| `add-workspace-dialog.tsx` | Create workspace form |
| `add-agent-dialog.tsx` | Create/edit agent form |
| `delete-workspace-dialog.tsx` | Workspace deletion confirmation |
| `credentials-dialog.tsx` | API key/OAuth configuration |
| `system-requirements-dialog.tsx` | Startup requirement checks |
| `welcome-modal.tsx` | First-run onboarding |

#### Utilities

| Component | Description |
|-----------|-------------|
| `icon-renderer.tsx` | Theme-aware icon display |
| `workspace-display.tsx` | Consistent workspace icon+name rendering |
| `resize-handle.tsx` | Draggable panel dividers |
| `theme-toggle.tsx` | Dark/light mode switch |
| `discobot-logo.tsx` | Application logo |

### AI Elements

Located in `components/ai-elements/`:

| Component | Description |
|-----------|-------------|
| `conversation.tsx` | Message list with auto-scroll |
| `message.tsx` | Individual message renderer |
| `prompt-input.tsx` | Chat input with attachments |

## Component Patterns

### Dialog Pattern

Dialogs use controlled mode with consistent props:

```typescript
interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingItem?: Item // For edit mode
  onSubmit: (data: FormData) => Promise<void>
}
```

Example:
```tsx
<AddWorkspaceDialog
  open={showDialog}
  onOpenChange={setShowDialog}
  onSubmit={handleCreate}
/>
```

### Tree Component Pattern

Tree components (sidebar, file panel) use recursive rendering:

```typescript
interface TreeNodeProps {
  node: TreeNode
  level: number
  isSelected: boolean
  onSelect: (node: TreeNode) => void
  renderIcon?: (node: TreeNode) => ReactNode
}

function TreeNode({ node, level, ...props }: TreeNodeProps) {
  return (
    <div style={{ paddingLeft: level * 16 }}>
      {node.children && <ChevronIcon expanded={expanded} />}
      <NodeContent node={node} />
      {expanded && node.children?.map(child => (
        <TreeNode key={child.id} node={child} level={level + 1} {...props} />
      ))}
    </div>
  )
}
```

### Panel Component Pattern

Panels accept state props for controlled behavior:

```typescript
interface PanelProps {
  isCollapsed: boolean
  onCollapse: (collapsed: boolean) => void
  height?: number
  onResize?: (delta: number) => void
  children: ReactNode
}
```

## IconRenderer Component

Handles theme-aware icon rendering:

```typescript
interface IconRendererProps {
  icons: Icon[]
  size?: number
  className?: string
}
```

Logic:
1. Filter icons by current theme (light/dark)
2. Prefer themed icon, fall back to unthemed
3. SVGs with `currentColor` rendered inline
4. Other images rendered as `<img>`

```tsx
<IconRenderer icons={agent.icons} size={16} className="mr-2" />
```

## WorkspaceDisplay Component

Provides consistent rendering of workspace icon and name across the application.

```typescript
interface WorkspaceDisplayProps {
  workspace: Workspace
  iconSize?: number        // Default: 16
  iconClassName?: string
  textClassName?: string
  className?: string
  showTooltip?: boolean    // Default: auto (true when displayName is used or path is shortened)
}
```

Features:
- Respects workspace `displayName` property (takes precedence over parsed path)
- Falls back to parsed path when no `displayName` is set
- Displays appropriate icon based on workspace type (local, git, GitHub)
- Shows tooltip with full path when needed
- Consistent display across sidebar, header, and welcome page

Usage:
```tsx
// Basic usage
<WorkspaceDisplay workspace={workspace} />

// With custom styling
<WorkspaceDisplay
  workspace={workspace}
  iconSize={20}
  iconClassName="h-5 w-5"
  textClassName="font-semibold text-lg"
/>

// Explicit tooltip control
<WorkspaceDisplay workspace={workspace} showTooltip={false} />
```

Path Display Logic:
- Local paths: Shortened with `~` for home directory (e.g., `~/projects/my-app`)
- Git repos: Shows `org/repo` format (e.g., `octocat/hello-world`)
- DisplayName: Always takes precedence when set (e.g., "My Project")

## SidebarTree Component

Displays workspace hierarchy:

```
Workspaces
├── My Project
│   ├── Session 1 (running)
│   └── Session 2 (stopped)
└── Another Project
    └── Session 3 (initializing)
```

Features:
- Expand/collapse workspaces
- Session status indicators
- Context menu for actions
- Drag selection (optional)

## TerminalView Component

xterm.js integration with WebSocket connection to sandbox containers.

### Props

```typescript
interface TerminalViewProps {
  sessionId: string | null
  root?: boolean                    // Run as root user (default: false)
  className?: string
  onToggleChat?: () => void
  hideHeader?: boolean
  onConnectionStatusChange?: (status: ConnectionStatus) => void
}

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"
```

### Imperative Handle

The component exposes a `reconnect()` method via `forwardRef`:

```typescript
interface TerminalViewHandle {
  reconnect: () => void
}

// Usage
const terminalRef = useRef<TerminalViewHandle>(null)
<TerminalView ref={terminalRef} sessionId={id} />
terminalRef.current?.reconnect()
```

### WebSocket Protocol

Connects to `/sessions/{sessionId}/terminal/ws?rows={rows}&cols={cols}&root={true|false}`

**Messages sent to server:**
```typescript
{ type: "input", data: string }                    // Keyboard input
{ type: "resize", data: { rows: number, cols: number } }  // Terminal resize
```

**Messages received from server:**
```typescript
{ type: "output", data: string }   // Terminal output
{ type: "error", data: string }    // Error message
```

### Features

- WebSocket connection to container PTY
- Automatic shell detection ($SHELL → /bin/bash → /bin/sh)
- User switching (root checkbox in UI)
- Connection lifecycle management (connect, disconnect, reconnect button)
- Debounced resize handling (150ms) to prevent loops
- Lazy mounting with CSS visibility for component persistence
- Theme-aware colors (Catppuccin-style)
- Web links addon for clickable URLs

### Connection Flow

1. User opens terminal tab
2. Frontend connects to WebSocket with session ID and dimensions
3. Server ensures sandbox is running, gets user info from agent-api `/user` endpoint
4. Server attaches to sandbox PTY with detected shell
5. Bidirectional communication: PTY ↔ Server WebSocket ↔ Frontend xterm.js

## DiffView Component

File diff display:

```typescript
interface DiffViewProps {
  file: FileNode
  showLineNumbers?: boolean
}
```

Features:
- Side-by-side or unified view
- Syntax highlighting
- Line additions/deletions
- Scroll synchronization

## Styling Conventions

### Tailwind Usage

```tsx
// Use design tokens
<div className="bg-background text-foreground border-border">

// IDE-specific tokens
<div className="bg-sidebar text-sidebar-foreground">

// Interactive states
<button className="hover:bg-muted focus:ring-2 focus:ring-ring">
```

### Class Organization

```tsx
// Group classes logically
<div className={cn(
  // Layout
  "flex flex-col gap-2",
  // Sizing
  "w-full h-full",
  // Styling
  "bg-background border rounded-md",
  // Interactive
  "hover:bg-muted cursor-pointer",
  // Conditional
  isSelected && "bg-accent"
)}>
```

### cn() Utility

The `cn()` function merges Tailwind classes:

```typescript
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

## Testing Considerations

- Mock SWR hooks for unit tests
- Use Testing Library for interaction tests
- Snapshot tests for complex renders
- Visual regression for theming
