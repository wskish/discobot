# Store Module

This module handles session and message storage, providing both in-memory access and file-based persistence.

## Files

| File | Description |
|------|-------------|
| `src/store/session.ts` | Session and message storage |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Session Store                               │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                  In-Memory Layer                          │  │
│  │  - UIMessage[] array                                      │  │
│  │  - Fast read/write access                                 │  │
│  │  - Lost on container restart                              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 File Persistence Layer                    │  │
│  │  - JSON file at SESSION_FILE path                        │  │
│  │  - Stores session metadata only                          │  │
│  │  - Messages recovered via ACP replay                     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│                    /tmp/agent-session.json                      │
└─────────────────────────────────────────────────────────────────┘
```

## SessionStore Class

### Constructor

```typescript
interface SessionStoreConfig {
  sessionFile?: string  // Default: /tmp/agent-session.json
}

class SessionStore {
  constructor(config?: SessionStoreConfig)
}
```

### Message Operations

#### getMessages()

Returns all stored messages:

```typescript
getMessages(): UIMessage[]
```

#### addMessage(message)

Adds a new message to the store:

```typescript
addMessage(message: UIMessage): void
```

#### updateMessage(id, updates)

Updates an existing message:

```typescript
updateMessage(id: string, updates: Partial<UIMessage>): void
```

Common use cases:
- Append text to assistant message content
- Add parts to message parts array
- Update tool invocation status

#### getLastAssistantMessage()

Returns the most recent assistant message:

```typescript
getLastAssistantMessage(): UIMessage | undefined
```

Used for appending streaming content.

#### clearMessages()

Removes all messages:

```typescript
clearMessages(): void
```

### Session Persistence

#### loadSession()

Loads session metadata from file:

```typescript
interface PersistedSession {
  sessionId: string
  cwd: string
  createdAt: string
}

loadSession(): PersistedSession | null
```

Returns null if file doesn't exist or is invalid.

#### saveSession(session)

Saves session metadata to file:

```typescript
saveSession(session: PersistedSession): void
```

File format:
```json
{
  "sessionId": "session-abc123",
  "cwd": "/workspace",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

#### clearSession()

Removes session file and clears messages:

```typescript
clearSession(): void
```

## Storage Strategy

### Message Storage

Messages are stored in-memory only:
- Fast access during session
- No persistence across restarts
- Recovered via ACP session replay

### Session Metadata Storage

Only session ID and metadata persisted:
- Enables session recovery
- Minimal disk usage
- ACP handles message persistence

### Recovery Flow

```
1. Container starts
   │
2. Load session metadata from file
   │
   ├─ File exists: Get sessionId
   │  │
   │  └─ Call ACP loadSession(sessionId)
   │     │
   │     └─ ACP replays all messages
   │        │
   │        └─ Store captures replayed messages
   │
   └─ File missing: Create new session
```

## Implementation Details

### In-Memory Store

```typescript
class SessionStore {
  private messages: UIMessage[] = []
  private sessionFile: string

  constructor(config?: SessionStoreConfig) {
    this.sessionFile = config?.sessionFile ?? '/tmp/agent-session.json'
  }

  getMessages(): UIMessage[] {
    return [...this.messages]  // Return copy
  }

  addMessage(message: UIMessage): void {
    this.messages.push(message)
  }

  updateMessage(id: string, updates: Partial<UIMessage>): void {
    const index = this.messages.findIndex(m => m.id === id)
    if (index !== -1) {
      this.messages[index] = { ...this.messages[index], ...updates }
    }
  }

  clearMessages(): void {
    this.messages = []
  }
}
```

### File Persistence

```typescript
class SessionStore {
  loadSession(): PersistedSession | null {
    try {
      const data = fs.readFileSync(this.sessionFile, 'utf-8')
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  saveSession(session: PersistedSession): void {
    fs.writeFileSync(
      this.sessionFile,
      JSON.stringify(session, null, 2)
    )
  }

  clearSession(): void {
    this.clearMessages()
    try {
      fs.unlinkSync(this.sessionFile)
    } catch {
      // File may not exist
    }
  }
}
```

## Message Part Updates

### Appending Text

```typescript
// Streaming text delta
const message = store.getLastAssistantMessage()
if (message) {
  const textPart = message.parts.find(p => p.type === 'text')
  if (textPart) {
    textPart.text += delta
  } else {
    message.parts.push({ type: 'text', text: delta })
  }
  message.content += delta
  store.updateMessage(message.id, message)
}
```

### Adding Tool Parts

```typescript
// Tool invocation received
const message = store.getLastAssistantMessage()
if (message) {
  message.parts.push({
    type: 'dynamic-tool',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    state: 'input-available',
    input: toolCall.input
  })
  store.updateMessage(message.id, message)
}
```

### Updating Tool Status

```typescript
// Tool completed
const message = store.getLastAssistantMessage()
if (message) {
  const toolPart = message.parts.find(
    p => p.type === 'dynamic-tool' && p.toolCallId === toolCallId
  )
  if (toolPart) {
    toolPart.state = 'output-available'
    toolPart.output = output
    store.updateMessage(message.id, message)
  }
}
```

## Error Handling

### File Read Errors

```typescript
loadSession(): PersistedSession | null {
  try {
    const data = fs.readFileSync(this.sessionFile, 'utf-8')
    const parsed = JSON.parse(data)
    // Validate required fields
    if (!parsed.sessionId) {
      console.warn('Invalid session file: missing sessionId')
      return null
    }
    return parsed
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to load session:', error)
    }
    return null
  }
}
```

### File Write Errors

```typescript
saveSession(session: PersistedSession): void {
  try {
    fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2))
  } catch (error) {
    console.error('Failed to save session:', error)
    // Continue without persistence
  }
}
```

## Testing

```typescript
describe('SessionStore', () => {
  let store: SessionStore
  const testFile = '/tmp/test-session.json'

  beforeEach(() => {
    store = new SessionStore({ sessionFile: testFile })
  })

  afterEach(() => {
    try { fs.unlinkSync(testFile) } catch {}
  })

  it('stores and retrieves messages', () => {
    const message: UIMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      parts: [{ type: 'text', text: 'Hello' }]
    }

    store.addMessage(message)
    const messages = store.getMessages()

    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].content, 'Hello')
  })

  it('updates message in place', () => {
    store.addMessage({ id: 'msg-1', role: 'assistant', content: '', parts: [] })
    store.updateMessage('msg-1', { content: 'Updated' })

    const messages = store.getMessages()
    assert.strictEqual(messages[0].content, 'Updated')
  })

  it('persists and loads session', () => {
    const session = {
      sessionId: 'sess-123',
      cwd: '/workspace',
      createdAt: new Date().toISOString()
    }

    store.saveSession(session)
    const loaded = store.loadSession()

    assert.strictEqual(loaded?.sessionId, 'sess-123')
  })
})
```
