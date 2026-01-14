# ACP Module

This module implements the Agent Client Protocol (ACP) client for communicating with Claude Code.

## Files

| File | Description |
|------|-------------|
| `src/acp/client.ts` | ACP client wrapper |
| `src/acp/translate.ts` | Type conversion functions |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ACP Client                                │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Connection Layer                        │  │
│  │  - Spawns claude-code-acp process                        │  │
│  │  - Manages stdio streams                                  │  │
│  │  - ndjson protocol framing                               │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                   Session Layer                           │  │
│  │  - Creates/loads/resumes sessions                        │  │
│  │  - Handles permission requests                           │  │
│  │  - Routes updates to callbacks                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           │                                      │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                 Translation Layer                         │  │
│  │  - UIMessage ↔ ContentBlock conversion                   │  │
│  │  - SessionUpdate → UIPart conversion                     │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## ACPClient Class

### Constructor

```typescript
interface ACPClientConfig {
  command: string      // e.g., "claude-code-acp"
  args: string[]       // Additional arguments
  cwd: string          // Working directory
}

class ACPClient {
  constructor(config: ACPClientConfig)
}
```

### Methods

#### connect()

Spawns the Claude Code process and establishes ACP connection:

```typescript
async connect(): Promise<void>
```

Implementation:
1. Spawn child process with configured command
2. Create Web Streams from stdio
3. Initialize ACP connection with ndjson transport
4. Set up error handlers

#### ensureSession()

Creates or loads an existing session:

```typescript
async ensureSession(): Promise<string>
```

Flow:
```
1. Try to load persisted session
   │
   ├─ Success: Replay messages, return session ID
   │
   └─ Failure: Try to resume session
               │
               ├─ Success: Return session ID
               │
               └─ Failure: Create new session
```

#### prompt(content)

Sends a prompt to the agent:

```typescript
async prompt(content: ContentBlock[]): Promise<void>
```

The response is received via the update callback.

#### setUpdateCallback(callback)

Registers handler for streaming updates:

```typescript
setUpdateCallback(callback: (update: SessionUpdate) => void): void
```

Update types received:
- `agent_message_chunk` - Text content
- `agent_thought_chunk` - Reasoning/thinking
- `tool_call` - Tool invocation start
- `tool_call_update` - Tool progress/completion
- `user_message_chunk` - Echo of user message (during replay)

#### cancel()

Cancels the current prompt:

```typescript
async cancel(): Promise<void>
```

#### disconnect()

Terminates the agent process:

```typescript
disconnect(): void
```

## Session Replay

When loading a persisted session, messages are replayed:

```typescript
async replaySession(sessionId: string): Promise<UIMessage[]> {
  const messages: UIMessage[] = []
  let currentMessage: UIMessage | null = null

  // Intercept updates during loadSession
  this.setUpdateCallback((update) => {
    switch (update.type) {
      case 'user_message_chunk':
        // Start new user message
        currentMessage = createUIMessage('user')
        // Append text content
        break

      case 'agent_message_chunk':
        // Start or continue assistant message
        if (!currentMessage || currentMessage.role !== 'assistant') {
          currentMessage = createUIMessage('assistant')
        }
        // Append text part
        break

      case 'tool_call':
        // Add tool invocation part
        break
    }
  })

  await this.acp.loadSession(sessionId)
  return messages
}
```

## Translation Functions

### uiMessageToContentBlocks()

Converts AI SDK message to ACP format:

```typescript
function uiMessageToContentBlocks(message: UIMessage): ContentBlock[] {
  return message.parts.map(part => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }

      case 'file':
        return {
          type: 'resource_link',
          uri: part.url,
          name: part.name,
          mimeType: part.mimeType
        }

      default:
        throw new Error(`Unsupported part type: ${part.type}`)
    }
  })
}
```

### sessionUpdateToUIPart()

Converts ACP update to AI SDK part:

```typescript
function sessionUpdateToUIPart(update: SessionUpdate): UIPart | null {
  switch (update.type) {
    case 'agent_message_chunk':
      return {
        type: 'text',
        text: update.content
      }

    case 'agent_thought_chunk':
      return {
        type: 'reasoning',
        text: update.content
      }

    case 'tool_call':
      return toolCallToUIPart(update)

    case 'tool_call_update':
      return toolCallUpdateToUIPart(update)

    default:
      return null
  }
}
```

### Tool Status Mapping

```typescript
function mapToolStatus(acpStatus: string): string {
  const mapping = {
    'pending': 'input-streaming',
    'in_progress': 'input-available',
    'completed': 'output-available',
    'failed': 'output-error'
  }
  return mapping[acpStatus] ?? 'input-streaming'
}
```

### toolCallToUIPart()

Converts tool call to dynamic tool part:

```typescript
function toolCallToUIPart(toolCall: ACPToolCall): DynamicToolUIPart {
  return {
    type: 'dynamic-tool',
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    state: mapToolStatus(toolCall.status),
    input: toolCall.input,
    output: toolCall.output
  }
}
```

## Message ID Generation

```typescript
function generateMessageId(): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `msg-${timestamp}-${random}`
}
```

## Error Handling

### Connection Errors

```typescript
try {
  await this.connect()
} catch (error) {
  if (error.code === 'ENOENT') {
    throw new Error(`Agent command not found: ${this.config.command}`)
  }
  throw error
}
```

### Session Errors

```typescript
try {
  await this.acp.loadSession(sessionId)
} catch (error) {
  console.warn('Failed to load session, creating new:', error)
  await this.acp.newSession()
}
```

### Permission Handling

The client auto-approves permission requests:

```typescript
this.acp.onPermissionRequest((request) => {
  return { approved: true }
})
```

## Testing

### Unit Tests (translate.test.ts)

```typescript
describe('sessionUpdateToUIPart', () => {
  it('converts agent_message_chunk to text part', () => {
    const update = {
      type: 'agent_message_chunk',
      content: 'Hello'
    }
    const part = sessionUpdateToUIPart(update)
    assert.deepStrictEqual(part, {
      type: 'text',
      text: 'Hello'
    })
  })

  it('converts tool_call to dynamic-tool part', () => {
    const update = {
      type: 'tool_call',
      id: 'tc-1',
      name: 'write_file',
      status: 'completed',
      input: { path: '/file.txt' },
      output: 'Success'
    }
    const part = sessionUpdateToUIPart(update)
    assert.strictEqual(part.type, 'dynamic-tool')
    assert.strictEqual(part.state, 'output-available')
  })
})
```

### Integration Tests

```typescript
describe('ACPClient', () => {
  it('sends prompt and receives response', async () => {
    const client = new ACPClient({
      command: 'claude-code-acp',
      args: [],
      cwd: '/workspace'
    })

    await client.connect()
    await client.ensureSession()

    const updates: SessionUpdate[] = []
    client.setUpdateCallback(u => updates.push(u))

    await client.prompt([{ type: 'text', text: 'Hello' }])

    assert(updates.some(u => u.type === 'agent_message_chunk'))
  })
})
```
