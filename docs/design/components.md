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
| `panel-controls.tsx` | Minimize/maximize buttons |
| `resize-handle.tsx` | Draggable panel dividers |
| `theme-toggle.tsx` | Dark/light mode switch |
| `octobot-logo.tsx` | Application logo |

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

## SidebarTree Component

Displays workspace hierarchy:

```
Workspaces
├── My Project
│   ├── Session 1 (running)
│   └── Session 2 (closed)
└── Another Project
    └── Session 3 (initializing)
```

Features:
- Expand/collapse workspaces
- Session status indicators
- Context menu for actions
- Drag selection (optional)

## TerminalView Component

xterm.js integration:

```typescript
interface TerminalViewProps {
  sessionId: string
  onCommand?: (command: string) => void
}
```

Features:
- WebSocket connection to container PTY
- Command history
- Resize on container change
- Copy/paste support
- Theme-aware colors

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
