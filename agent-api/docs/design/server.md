# Server Module

This module implements the HTTP API using Hono web framework.

## Files

| File | Description |
|------|-------------|
| `src/server/app.ts` | Hono application with routes |
| `src/index.ts` | Server bootstrap and configuration |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HTTP Server (Hono)                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                     Routes                            │  │
│  │  GET  /        → Status check                        │  │
│  │  GET  /health  → Health with ACP status              │  │
│  │  GET  /user    → Get sandbox user info               │  │
│  │  GET  /chat    → Get all messages                    │  │
│  │  POST /chat    → Send message (SSE response)         │  │
│  │  DELETE /chat  → Clear session                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  Dependencies                         │  │
│  │  - ACPClient (acp/client.ts)                         │  │
│  │  - SessionStore (store/session.ts)                   │  │
│  │  - translate functions (acp/translate.ts)            │  │
│  │  - stream functions (server/stream.ts)               │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Application Factory

### createApp()

Creates and configures the Hono application:

```typescript
interface AppConfig {
  agentCommand: string
  agentArgs: string[]
  agentCwd: string
}

function createApp(config: AppConfig): Hono
```

The factory:
1. Creates ACP client with config
2. Creates session store
3. Registers all routes
4. Returns configured Hono app

## Routes

### GET /

Service status endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "agent"
}
```

### GET /health

Detailed health check with ACP connection status.

**Response:**
```json
{
  "status": "ok",
  "acp": {
    "connected": true,
    "sessionId": "session-123"
  }
}
```

### GET /user

Returns information about the current sandbox user. Used by the server to determine the default user for terminal sessions.

**Response:**
```json
{
  "username": "discobot",
  "uid": 1000,
  "gid": 1000
}
```

The endpoint uses Node.js `os.userInfo()` to get the current process user. This allows the server to run terminal sessions as the correct non-root user without hardcoding usernames.

### GET /chat

Returns all stored messages from current session.

**Response:**
```json
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Hello",
      "parts": [{"type": "text", "text": "Hello"}]
    },
    {
      "id": "msg-2",
      "role": "assistant",
      "content": "Hi there!",
      "parts": [{"type": "text", "text": "Hi there!"}]
    }
  ]
}
```

### POST /chat

Send a user message and stream the assistant response.

**Request:**
```json
{
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": "Write a function...",
      "parts": [{"type": "text", "text": "Write a function..."}]
    }
  ]
}
```

**Response (SSE):**
```
Content-Type: text/event-stream

data: {"type": "text-delta", "id": "msg-2", "delta": "Here"}
data: {"type": "text-delta", "id": "msg-2", "delta": "'s a function:"}
data: {"type": "tool-input-available", "toolCallId": "tc-1", "toolName": "write_file", "input": {...}}
data: {"type": "tool-output-available", "toolCallId": "tc-1", "output": "File written"}
data: {"type": "finish", "messageId": "msg-2"}
```

**Error Response (SSE):**
```
data: {"type": "error", "errorText": "Connection failed"}
```

### DELETE /chat

Clear the current session and all messages.

**Response:**
```json
{
  "status": "ok"
}
```

## SSE Event Types

| Type | Fields | Description |
|------|--------|-------------|
| `text-delta` | `id`, `delta` | Incremental text content |
| `reasoning-delta` | `id`, `delta` | Incremental reasoning/thought |
| `tool-input-streaming` | `toolCallId`, `toolName` | Tool call started |
| `tool-input-available` | `toolCallId`, `toolName`, `input` | Tool input ready |
| `tool-output-available` | `toolCallId`, `output` | Tool completed |
| `tool-output-error` | `toolCallId`, `error` | Tool failed |
| `finish` | `messageId` | Response complete |
| `error` | `errorText` | Error occurred |

## Request Processing

### POST /chat Flow

```typescript
async function handleChat(c: Context) {
  // 1. Parse request body
  const { messages } = await c.req.json<{ messages: UIMessage[] }>()

  // 2. Extract last user message
  const lastMessage = messages.filter(m => m.role === 'user').pop()
  if (!lastMessage) {
    return c.json({ error: 'No user message' }, 400)
  }

  // 3. Ensure ACP connection and session
  await acpClient.connect()
  await acpClient.ensureSession()

  // 4. Add user message to store
  store.addMessage(lastMessage)

  // 5. Create assistant message placeholder
  const assistantMessage = createUIMessage('assistant')
  store.addMessage(assistantMessage)

  // 6. Convert to ACP format
  const content = uiMessageToContentBlocks(lastMessage)

  // 7. Set up SSE response
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()

  // 8. Handle ACP updates
  acpClient.setUpdateCallback((update) => {
    // Convert directly to stream chunks
    const chunks = sessionUpdateToChunks(update, state, ids)
    // Accumulate parts in assistant message
    // Write SSE events
    for (const chunk of chunks) sendSSE(chunk)
  })

  // 9. Send prompt
  await acpClient.prompt(content)

  // 10. Return SSE stream
  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream' }
  })
}
```

## Error Handling

### Request Validation

```typescript
// Missing messages
if (!body.messages?.length) {
  return c.json({ error: 'No messages provided' }, 400)
}

// No user message
if (!lastUserMessage) {
  return c.json({ error: 'No user message found' }, 400)
}
```

### Connection Errors

```typescript
try {
  await acpClient.connect()
} catch (error) {
  return c.json({ error: 'Failed to connect to agent' }, 500)
}
```

### Stream Errors

```typescript
acpClient.setErrorCallback((error) => {
  writer.write(`data: ${JSON.stringify({
    type: 'error',
    errorText: error.message
  })}\n\n`)
  writer.close()
})
```

## Server Bootstrap

### index.ts

```typescript
import { serve } from '@hono/node-server'
import { createApp } from './server/app'

// Load configuration from environment
const config = {
  agentCommand: process.env.AGENT_COMMAND ?? 'claude-code-acp',
  agentArgs: (process.env.AGENT_ARGS ?? '').split(' ').filter(Boolean),
  agentCwd: process.env.AGENT_CWD ?? process.cwd(),
}

// Create application
const app = createApp(config)

// Start server
const port = parseInt(process.env.PORT ?? '3001')
serve({ fetch: app.fetch, port })

console.log(`Agent server running on port ${port}`)
```

## Testing

The server is tested via:
- Unit tests for route handlers
- Integration tests with mock ACP client
- E2E tests with real Claude Code

```typescript
// test/e2e.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('POST /chat', () => {
  it('streams response', async () => {
    const response = await fetch('http://localhost:3001/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [...] })
    })

    assert.strictEqual(response.headers.get('content-type'), 'text/event-stream')
    // Parse and validate SSE events
  })
})
```
