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

## State Management

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
- Sidebar toggle button
- Discobot logo and breadcrumb navigation
- API Credentials button
- Theme toggle
- Window controls (Tauri only)

#### Breadcrumb Navigation

The header implements a dynamic breadcrumb navigation system with workspace and session dropdowns:

**Breadcrumb Structure:**
```
Discobot / [Workspace] / [Session] / [New Session]
```

**Conditional Rendering Logic:**

1. **When `isSessionLoading = true`:**
   - Shows "Loading..." placeholder
   - Breadcrumb: `Discobot / Loading...`

2. **When `workspaces.length === 0`:**
   - Shows "Add Workspace" button instead of dropdown
   - Clicking opens the workspace creation dialog
   - Breadcrumb: `Discobot / [Add Workspace]`

3. **When workspaces exist but none selected:**
   - Shows workspace dropdown with "Select Workspace" placeholder
   - Shows "New Session" button at end (passes undefined workspace)
   - Breadcrumb: `Discobot / [Select Workspace] / [New Session]`

4. **When workspace selected, no sessions:**
   - Shows workspace dropdown with workspace name
   - No session dropdown visible
   - Shows "New Session" button at end
   - Breadcrumb: `Discobot / [WorkspaceName] / [New Session]`

5. **When workspace selected, sessions exist, none selected:**
   - Shows workspace dropdown with workspace name
   - Shows session dropdown with "Select Session" placeholder
   - Shows "New Session" button at end
   - Breadcrumb: `Discobot / [WorkspaceName] / [Select Session] / [New Session]`

6. **When both workspace and session selected:**
   - Shows workspace dropdown with workspace name
   - Shows session dropdown with session name
   - Session shows status indicator
   - Shows "New Session" button at end
   - Breadcrumb: `Discobot / [WorkspaceName] / [SessionName] / [New Session]`

**Workspace Dropdown Features:**
- Lists all workspaces
- Delete button on hover with inline confirmation (check/cancel buttons)
- "Add Workspace" menu item at bottom
- Clicking workspace calls `showWorkspaceSessions(workspaceId)`
- Selected workspace indicated with checkmark

**Session Dropdown Features:**
- Only visible when `workspaceSessions.length > 0`
- Lists all sessions in the current workspace
- Delete button on hover with inline confirmation
- Status indicators for each session
- "New Session" menu item at bottom
- Clicking session calls `showSession(sessionId)`
- Selected session indicated with checkmark

**New Session Button:**
- Only visible when `workspaces.length > 0`
- Always positioned at end of breadcrumb with forward slash separator
- Passes current workspace ID if one is selected
- Calls `showNewSession({ workspaceId })`

**Delete Confirmation Flow:**
- Delete button appears on hover over workspace/session items
- Clicking delete shows inline check/cancel buttons
- Confirming delete:
  - Calls `deleteWorkspace(workspaceId)` or `deleteSession(sessionId)`
  - If deleting current workspace/session, calls `showNewSession()`
- Canceling delete hides confirmation buttons

**Integration with MainPanelContext:**
- Uses `getSelectedWorkspaceId()` and `getSelectedSessionId()` to determine current selection
- Uses `showNewSession()`, `showSession()`, and `showWorkspaceSessions()` for navigation
- Uses `selectedSession` for displaying session name and status
- Uses `isSessionLoading` to show loading state

**Workspace Creation Flow:**
When a workspace is successfully created via "Add Workspace":
1. Workspace is created via API
2. Dialog closes automatically
3. UI navigates to new session screen via `showNewSession({ workspaceId: ws.id })`
4. Newly created workspace is preselected in dropdown
5. User can immediately start creating a session

**Test Scenarios:**
See `components/ide/layout/header.test-scenarios.md` for comprehensive test coverage documentation with 17 detailed scenarios.

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
- File mode: Shows DiffContent for opened files
- Service mode: Shows ServiceView for running services
- ChatPanel is always mounted (never unmounted) to preserve component state and prevent re-initialization
- When no session is selected, the chat panel displays centered with the welcome UI
- Panel uses absolute positioning for terminal/chat/file/service overlays to avoid layout shifts
- Takes full flex space in the main content area

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

- **HomePage.tsx** - Imports layout components and manages state
- **ProjectEventsProvider** - Triggers cache invalidation on SSE events
- **useWorkspaces/useSessions** - Provides data for sidebar tree (used directly, no context wrapper)
- **MainPanelProvider** - Manages selected workspace/session state
