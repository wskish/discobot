# Layout Module

The layout module manages the IDE's panel system, including resizable panels, collapse states, and the overall page composition.

## Files

| File | Description |
|------|-------------|
| `components/ide/layout/index.ts` | Barrel exports for layout components |
| `components/ide/layout/header.tsx` | Top navigation bar with logo and controls |
| `components/ide/layout/left-sidebar.tsx` | Vertical split with workspace tree and agents |
| `components/ide/layout/main-content.tsx` | Central area with diff and bottom panels |
| `components/ide/layout/diff-panel.tsx` | Tabbed file diff viewer wrapper |
| `components/ide/layout/bottom-panel.tsx` | Chat or terminal toggle area |
| `components/ide/resize-handle.tsx` | Draggable panel divider |
| `components/ide/panel-controls.tsx` | Minimize/maximize/close buttons |
| `lib/hooks/use-panel-layout.ts` | Panel state management hook |
| `lib/hooks/use-persisted-state.ts` | localStorage persistence hook |

## Panel Architecture

### Three-Panel Layout

```
┌──────────────────────────────────────────────────────────┐
│                        Header                            │
├────────────┬─────────────────────────────────────────────┤
│            │                                             │
│   Left     │              Main Content                   │
│  Sidebar   │  ┌───────────────────────────────────────┐ │
│ (280px     │  │         Diff Panel                    │ │
│  default)  │  │       (collapsible)                   │ │
│            │  ├───────────────────────────────────────┤ │
│            │  │        Bottom Panel                   │ │
│            │  │    (Chat or Terminal)                 │ │
│            │  └───────────────────────────────────────┘ │
└────────────┴─────────────────────────────────────────────┘
```

### ResizeHandle Component

The `ResizeHandle` component creates draggable dividers between panels:

```typescript
interface ResizeHandleProps {
  orientation: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  className?: string
}
```

Usage:
```tsx
<ResizeHandle
  orientation="vertical"
  onResize={(delta) => setSidebarWidth(prev => prev + delta)}
/>
```

Features:
- Drag-to-resize with mouse
- Visual feedback on hover/drag
- Respects min/max constraints
- Works for both horizontal and vertical splits

### PanelControls Component

Controls for panel minimize/maximize:

```typescript
interface PanelControlsProps {
  isMinimized: boolean
  isMaximized: boolean
  onMinimize: () => void
  onMaximize: () => void
  onClose?: () => void
}
```

## State Management

### usePanelLayout Hook

Manages panel dimensions and collapse states:

```typescript
const {
  sidebarWidth,
  setSidebarWidth,
  diffPanelHeight,
  setDiffPanelHeight,
  isDiffPanelCollapsed,
  setDiffPanelCollapsed,
  isBottomPanelCollapsed,
  setBottomPanelCollapsed,
} = usePanelLayout()
```

### usePersistedState Hook

Syncs state to localStorage for persistence across page reloads:

```typescript
const [width, setWidth] = usePersistedState('sidebar-width', 280)
```

Implementation details:
- Debounced writes to localStorage
- SSR-safe (no-op on server)
- Type-safe with generics
- Falls back to default on parse error

## Layout Components

### Header

Top navigation containing:
- Octobot logo
- Theme toggle
- User menu (when authenticated)

### LeftSidebar

Vertical split with two sections:
1. **Workspace Tree** - Expandable tree of workspaces and sessions
2. **Agents Panel** - List of configured AI agents

The split ratio is adjustable via internal resize handle.

### MainContent

Central area managing:
- Diff panel (top) with collapsible behavior
- Bottom panel (bottom) with chat/terminal toggle
- Resize handle between panels

### DiffPanel

Wrapper for the tabbed diff viewer:
- Shows file tabs when files are open
- Collapses when no files selected
- Can be manually minimized/maximized

### BottomPanel

Toggleable content area with persistent chat component:
- Chat mode: Shows ChatPanel with AI conversation
- Terminal mode: Shows TerminalView with xterm.js
- ChatPanel is always mounted (never unmounted) to preserve component state and prevent re-initialization
- When no session is selected, the chat panel displays centered with the welcome UI
- Panel uses absolute positioning for terminal/chat overlays to avoid layout shifts

## CSS and Styling

Panels use Tailwind CSS with design tokens:

```css
/* Panel backgrounds */
.bg-sidebar { background: var(--sidebar); }
.bg-background { background: var(--background); }

/* Borders */
.border-border { border-color: var(--border); }
```

## Responsive Behavior

The layout is designed for desktop use:
- Minimum viewport width: 1024px
- Panels have minimum dimensions
- Collapse states for smaller screens

## Integration Points

- **page.tsx** - Imports layout components and passes state
- **ProjectEventsProvider** - Triggers cache invalidation on SSE events
- **useWorkspaces/useSessions** - Provides data for sidebar tree (used directly, no context wrapper)
