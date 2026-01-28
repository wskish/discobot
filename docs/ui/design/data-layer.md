# Data Layer Module

The data layer provides server state management using SWR hooks and a centralized API client.

## Files

| File | Description |
|------|-------------|
| `lib/api-client.ts` | REST API client singleton |
| `lib/api-config.ts` | API configuration (project ID, base URL) |
| `lib/api-types.ts` | Shared TypeScript interfaces |
| `lib/hooks/use-workspaces.ts` | Workspace CRUD hook |
| `lib/hooks/use-sessions.ts` | Session CRUD hook |
| `lib/hooks/use-agents.ts` | Agent CRUD hook |
| `lib/hooks/use-agent-types.ts` | Available agent types hook |
| `lib/hooks/use-credentials.ts` | Credential management hook |
| `lib/hooks/use-preferences.ts` | User preferences hook |
| `lib/hooks/use-files.ts` | File operations hook |
| `lib/hooks/use-session-files.ts` | Lazy-loaded file tree with diff support |
| `lib/hooks/use-messages.ts` | Chat message history hook |
| `lib/hooks/use-suggestions.ts` | Autocomplete suggestions hook |
| `lib/hooks/use-project-events.ts` | SSE subscription hook |

## API Configuration

### api-config.ts

```typescript
export const PROJECT_ID = "local"

export function getApiBase() {
  return `/api/projects/${PROJECT_ID}`
}
```

The project ID is hardcoded to "local" for single-user mode. Multi-tenant mode would require dynamic project selection.

## API Client

### ApiClient Class

Singleton client for REST operations:

```typescript
class ApiClient {
  private baseUrl: string

  constructor() {
    this.baseUrl = getApiBase()
  }

  // Workspace methods
  async getWorkspaces(): Promise<Workspace[]>
  async createWorkspace(req: CreateWorkspaceRequest): Promise<Workspace>
  async updateWorkspace(id: string, req: UpdateWorkspaceRequest): Promise<Workspace>
  async deleteWorkspace(id: string): Promise<void>

  // Session methods
  async getSession(id: string): Promise<Session>
  async updateSession(id: string, req: UpdateSessionRequest): Promise<Session>
  async deleteSession(id: string): Promise<void>

  // Agent methods
  async getAgents(): Promise<Agent[]>
  async createAgent(req: CreateAgentRequest): Promise<Agent>
  async updateAgent(id: string, req: UpdateAgentRequest): Promise<Agent>
  async deleteAgent(id: string): Promise<void>
  async setDefaultAgent(id: string): Promise<void>

  // Agent types
  async getAgentTypes(): Promise<SupportedAgentType[]>

  // Credentials
  async getCredentials(): Promise<Credential[]>
  async createCredential(req: CreateCredentialRequest): Promise<Credential>
  async deleteCredential(id: string): Promise<void>

  // Files and messages
  async getFiles(sessionId: string): Promise<FileNode[]>
  async getMessages(sessionId: string): Promise<UIMessage[]>

  // Suggestions
  async getSuggestions(query: string, type: 'path' | 'repo'): Promise<string[]>
}

export const apiClient = new ApiClient()
```

## SWR Hooks

### Pattern

All hooks follow a consistent pattern:

```typescript
function useResource() {
  const { data, error, isLoading, mutate } = useSWR(
    'resource-key',
    () => apiClient.getResource()
  )

  const createResource = async (req: CreateRequest) => {
    const created = await apiClient.createResource(req)
    await mutate() // Refresh cache
    return created
  }

  return {
    resources: data ?? [],
    isLoading,
    error,
    createResource,
    // ... other mutations
  }
}
```

### useWorkspaces

```typescript
const {
  workspaces,
  isLoading,
  error,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} = useWorkspaces()

// For cache invalidation from outside the hook (e.g., SSE handlers)
import { invalidateWorkspaces } from "@/lib/hooks/use-workspaces"
invalidateWorkspaces()
```

Features:
- Returns all workspaces
- Automatic cache invalidation on mutations
- Exports `invalidateWorkspaces()` for external cache control (used by ProjectEventsProvider)

### useSessions

```typescript
// Fetch sessions for a workspace
const { sessions, isLoading, error } = useSessions(workspaceId, { includeClosed: false })

// Fetch a single session
const { session, isLoading, error, updateSession } = useSession(sessionId)

// Delete sessions
const { deleteSession } = useDeleteSession()

// For cache invalidation from outside the hook (e.g., SSE handlers)
import {
  invalidateSession,
  removeSessionFromCache,
  invalidateAllSessionsCaches,
} from "@/lib/hooks/use-sessions"

invalidateSession(sessionId)           // Trigger refetch of single session
removeSessionFromCache(sessionId)      // Remove without refetch (for deletions)
invalidateAllSessionsCaches()          // Refresh all session lists
```

Features:
- `useSessions(workspaceId)` fetches sessions for a workspace
- `useSession(sessionId)` fetches a single session with update capability
- Exports cache mutation functions for external control (used by ProjectEventsProvider)

### useAgents

```typescript
const {
  agents,
  defaultAgent,
  isLoading,
  createAgent,
  updateAgent,
  deleteAgent,
  setDefaultAgent,
} = useAgents()
```

The hook identifies the default agent from the list based on the `isDefault` flag.

### useAgentTypes

```typescript
const { agentTypes, isLoading } = useAgentTypes()
```

Returns available agent templates with:
- Type ID (e.g., "claude-code", "gemini-cli")
- Display name
- Icons (light/dark variants)
- Available modes and models

### useCredentials

```typescript
const {
  credentials,
  isLoading,
  createCredential,
  deleteCredential,
} = useCredentials()
```

Manages encrypted API keys and OAuth tokens.

### usePreferences

```typescript
const {
  preferences,
  isLoading,
  error,
  getPreference,
  setPreference,
  setPreferences,
  deletePreference,
} = usePreferences()
```

Manages user preferences (key/value store scoped to the authenticated user).

**Features:**
- User-scoped (not project-scoped)
- Values stored as strings (can be JSON for complex values)
- `getPreference(key)` helper returns value or undefined
- Automatic cache invalidation on mutations

**Example usage:**

```typescript
// Get current theme
const theme = getPreference('theme') // "dark" | "light" | undefined

// Set a preference
await setPreference('theme', 'dark')

// Set multiple preferences at once
await setPreferences({
  theme: 'dark',
  editor: 'vim',
  fontSize: '14',
})

// Delete a preference
await deletePreference('theme')
```

**Common preference keys:**
- `theme` - UI theme (light/dark)
- `preferredIDE` - Default IDE for sessions
- `editor` - Editor preferences
- `user.settings.*` - Namespaced user settings

### useSessionFiles

```typescript
const {
  fileTree,
  isLoading,
  diffStats,
  changedFiles,
  diffEntries,
  expandedPaths,
  expandDirectory,
  collapseDirectory,
  toggleDirectory,
  expandAll,
  collapseAll,
  isPathLoading,
  refresh,
} = useSessionFiles(sessionId, loadAllFiles)
```

Manages a lazy-loaded file tree with diff support for session files.

**Parameters:**
- `sessionId`: The session ID to load files for
- `loadAllFiles`: When `true`, loads the full directory structure on-demand. When `false`, only shows changed files without lazy loading.

**Features:**
- **Lazy loading**: Directories are loaded on-demand when expanded
- **Diff support**: Shows added, modified, deleted, and renamed files
- **Auto-expansion**: Single-child directory chains are automatically expanded
- **Ghost directories**: Deleted files appear in the tree even if their parent directories don't exist on disk
- **Optimistic expansion**: `expandAll()` recursively loads and expands all directories in parallel

**File tree structure:**

```typescript
interface LazyFileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  children?: LazyFileNode[]  // undefined = not loaded, [] = loaded but empty
  changed?: boolean
  status?: 'added' | 'modified' | 'deleted' | 'renamed'
}
```

**Example usage:**

```typescript
// Load file tree for a session
const { fileTree, expandedPaths, expandDirectory, expandAll } = useSessionFiles(sessionId, true)

// Expand a directory (triggers lazy load if needed)
await expandDirectory('src/components')

// Expand all directories recursively
await expandAll()  // Loads all unloaded directories and expands them

// Check if a directory is currently loading
const loading = isPathLoading('src/components')
```

**Auto-expansion behavior:**

When expanding a directory that contains only one child (and that child is also a directory), the hook automatically expands the entire chain until it reaches a directory with multiple children, a file, or an empty directory.

Example: Expanding `src` will auto-expand through `src/components/ui` if each level has only one directory child.

**Expand All implementation:**

The `expandAll()` function recursively:
1. Traverses the current file tree
2. Identifies unloaded directories (`children === undefined`)
3. Loads them in parallel using API calls
4. Recursively processes newly discovered subdirectories
5. Updates the expanded paths to show all directories

This ensures that clicking "Expand All" will show the complete directory structure, even for directories that haven't been loaded yet.

### useProjectEvents

```typescript
const { isConnected, reconnect, disconnect } = useProjectEvents({
  onSessionUpdated: (data) => {
    // data: { sessionId: string, status: string }
    console.log("Session updated:", data.sessionId, data.status)
  },
  onWorkspaceUpdated: (data) => {
    // data: { workspaceId: string, status: string }
    console.log("Workspace updated:", data.workspaceId, data.status)
  },
  autoReconnect: true,    // Default: true
  reconnectDelay: 3000,   // Default: 3000ms
})
```

This hook manages the SSE connection and calls callbacks when events arrive. It does NOT handle SWR cache mutations directly - that responsibility belongs to `ProjectEventsProvider`.

Features:
- Manages SSE connection lifecycle
- Automatically reconnects on disconnect
- Callbacks stored in refs to prevent reconnection on callback changes
- Returns connection status and manual control functions

## Type Definitions

### Core Types (api-types.ts)

```typescript
// Resources
interface Workspace {
  id: string
  name: string
  path?: string
  gitRepo?: string
  status: WorkspaceStatus
  createdAt: string
  updatedAt: string
}
// Note: Sessions are fetched separately via useSessions(workspaceId)

interface Session {
  id: string
  name: string
  workspaceId: string
  agentId: string
  status: SessionStatus
  files: FileNode[]
  createdAt: string
  updatedAt: string
}

interface Agent {
  id: string
  name: string
  type: string
  mode: string
  model: string
  icons: Icon[]
  isDefault: boolean
  mcpServers?: MCPServer[]
}

// Enums
type WorkspaceStatus = 'initializing' | 'ready' | 'error'
type SessionStatus = 'initializing' | 'reinitializing' | 'cloning' | 'pulling_image' | 'creating_sandbox' | 'ready' | 'stopped' | 'error' | 'removing' | 'removed'

// File tree
interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  content?: string
  originalContent?: string
}
```

## Caching Strategy

### SWR Configuration

Default SWR options:
- `revalidateOnFocus`: true
- `revalidateOnReconnect`: true
- `dedupingInterval`: 2000ms

### Cache Keys

| Resource | Key Pattern |
|----------|-------------|
| Workspaces | `workspaces` |
| Sessions list | `sessions-{workspaceId}-{includeClosed}` |
| Session | `session-{id}` |
| Agents | `agents` |
| Agent Types | `agent-types` |
| Credentials | `credentials` |
| Preferences | `preferences` |
| Files | `files-{sessionId}` |
| Session files (root) | `session-files-{sessionId}-root` |
| Session files (diff) | `session-diff-{sessionId}-files` |
| Session file diff | `session-diff-{sessionId}-{path}` |
| Messages | `messages-{sessionId}` |

### Invalidation

When data changes:
1. Mutation completes on server
2. Hook calls `mutate(key)`
3. SWR refetches from API
4. Components re-render with fresh data

For real-time updates via SSE:
- `ProjectEventsProvider` listens for SSE events
- On session update: calls `invalidateSession()` and `invalidateAllSessionsCaches()`
- On session removal: calls `removeSessionFromCache()` (no refetch needed)
- On workspace update: calls `invalidateWorkspaces()`

This pattern keeps SWR key knowledge in the hooks that define them, while the provider handles event routing.

## Error Handling

Errors propagate through SWR's `error` field:
- Network errors: Displayed in UI
- 4xx errors: Handled based on status code
- 5xx errors: Generic error message

```typescript
if (error) {
  return <ErrorDisplay error={error} />
}
```

## Integration Points

- **ChatPanel**: Uses `useSession`, `useMessages`, `useWorkspaces`
- **SidebarTree**: Uses `useWorkspaces`, `useSessions`
- **AgentsPanel**: Uses `useAgents`
- **Dialogs**: Use respective hooks for CRUD operations
- **ProjectEventsProvider**: Uses `useProjectEvents` for SSE, calls exported cache mutation functions

## Context Providers

The app uses a minimal set of React contexts for state that requires coordination:

```typescript
// lib/contexts/app-provider.tsx
<ProjectEventsProvider>    {/* SSE connection + cache mutations */}
  <MainPanelProvider>      {/* Main panel view state and session data */}
    {children}
  </MainPanelProvider>
</ProjectEventsProvider>
```

**Design principle**: Contexts are only used when they add value beyond what SWR provides:
- `MainPanelProvider`: Manages main panel view state (which session/workspace to show) and fetches current session data
- `ProjectEventsProvider`: Coordinates SSE connection with cache invalidation

**No WorkspaceContext, SessionContext, or AgentContext**: Components use `useWorkspaces()`, `useSession()`, `useAgents()`, and `useAgentTypes()` directly since SWR already provides shared cache and request deduplication. Session selection is managed by `MainPanelProvider` which maintains the current view state. Agent selection (for UI highlighting in agents panel) is managed locally within the AgentsPanel component.
