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
| `lib/hooks/use-files.ts` | File operations hook |
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
```

Features:
- Returns all workspaces with their sessions
- Automatic cache invalidation on mutations
- Optimistic updates for responsive UI

### useSessions

```typescript
const {
  session,
  isLoading,
  error,
  updateSession,
  deleteSession,
} = useSession(sessionId)

const { deleteSession } = useDeleteSession()
```

Note: Sessions are typically accessed via workspaces. The `useSession` hook is for single-session operations.

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

### useProjectEvents

```typescript
useProjectEvents({
  onSessionUpdated: (sessionId) => mutateSession(sessionId),
  onWorkspaceUpdated: (workspaceId) => mutateWorkspace(workspaceId),
})
```

Subscribes to SSE stream for real-time updates:
- Automatically reconnects on disconnect
- Triggers SWR mutations on events
- Debounces rapid events

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
  sessions: Session[]
  createdAt: string
  updatedAt: string
}

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
type SessionStatus = 'initializing' | 'running' | 'closed' | 'error'

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
| Session | `session-{id}` |
| Agents | `agents` |
| Agent Types | `agent-types` |
| Credentials | `credentials` |
| Files | `files-{sessionId}` |
| Messages | `messages-{sessionId}` |

### Invalidation

When data changes:
1. Mutation completes on server
2. Hook calls `mutate(key)`
3. SWR refetches from API
4. Components re-render with fresh data

For related resources (e.g., workspace contains sessions):
- Update workspace triggers workspace list refresh
- New session triggers workspace list refresh

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

- **ChatPanel**: Uses `useSession`, `useMessages`
- **SidebarTree**: Uses `useWorkspaces`
- **AgentsPanel**: Uses `useAgents`
- **Dialogs**: Use respective hooks for CRUD operations
- **useProjectEvents**: Connects SSE to SWR mutations
