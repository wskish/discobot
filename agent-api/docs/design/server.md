# Server Module

This module implements the HTTP API using Hono web framework.

## Files

| File | Description |
|------|-------------|
| `src/server/app.ts` | Hono application with routes |
| `src/server/completion.ts` | Background completion handling |
| `src/index.ts` | Server bootstrap and configuration |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    HTTP Server (Hono)                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                     Routes                            │  │
│  │  GET  /        → Status check                        │  │
│  │  GET  /health  → Health with agent status            │  │
│  │  GET  /user    → Get sandbox user info               │  │
│  │  GET  /chat    → Get all messages                    │  │
│  │  POST /chat    → Send message (background + SSE)     │  │
│  │  GET  /chat/events → SSE stream for events           │  │
│  │  DELETE /chat  → Clear session                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                  │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  Dependencies                         │  │
│  │  - Agent (agent/interface.ts)                        │  │
│  │  - SessionStore (store/session.ts)                   │  │
│  │  - completion (server/completion.ts)                 │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Application Factory

### createApp()

Creates and configures the Hono application:

```typescript
interface AppConfig {
  agent: Agent
}

function createApp(config: AppConfig): Hono
```

The factory:
1. Accepts an Agent implementation
2. Registers all routes
3. Returns configured Hono app

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

Detailed health check with agent connection status.

**Response:**
```json
{
  "status": "ok",
  "agent": {
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

The endpoint uses Node.js `os.userInfo()` to get the current process user.

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

Start a completion in the background. Returns immediately with a completion ID.

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

**Response (202 Accepted):**
```json
{
  "completionId": "abc12345",
  "status": "started"
}
```

**Error Response (409 Conflict):**
```json
{
  "error": "completion_in_progress",
  "completionId": "existing123"
}
```

### GET /chat/events

SSE stream for completion events. Connect before or after POST /chat.

**Response (SSE):**
```
Content-Type: text/event-stream

data: {"type": "start", "messageId": "msg-2"}
data: {"type": "text-delta", "id": "msg-2", "delta": "Here"}
data: {"type": "text-delta", "id": "msg-2", "delta": "'s a function:"}
data: {"type": "tool-input-available", "toolCallId": "tc-1", "toolName": "write_file", "input": {...}}
data: {"type": "tool-output-available", "toolCallId": "tc-1", "output": "File written"}
data: {"type": "finish"}
```

**Error Event:**
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
| `start` | `messageId` | Completion started |
| `text-start` | `id` | Text block started |
| `text-delta` | `id`, `delta` | Incremental text content |
| `text-end` | `id` | Text block complete |
| `reasoning-start` | `id` | Reasoning block started |
| `reasoning-delta` | `id`, `delta` | Incremental reasoning |
| `reasoning-end` | `id` | Reasoning block complete |
| `tool-input-start` | `toolCallId`, `toolName` | Tool call started |
| `tool-input-delta` | `toolCallId`, `partialInput` | Tool input streaming |
| `tool-input-available` | `toolCallId`, `toolName`, `input` | Tool input ready |
| `tool-output-available` | `toolCallId`, `output` | Tool completed |
| `tool-output-error` | `toolCallId`, `errorText` | Tool failed |
| `finish` | | Response complete |
| `error` | `errorText` | Error occurred |

## Completion Flow

### Background Completion Architecture

```
Client                    Server                    Agent
  │                         │                         │
  ├─POST /chat─────────────►│                         │
  │◄─202 {completionId}─────│                         │
  │                         │                         │
  ├─GET /chat/events───────►│                         │
  │                         ├─agent.prompt()─────────►│
  │                         │  (async generator)      │
  │                         │◄─yield chunk───────────┤
  │◄──SSE: chunk────────────│                         │
  │                         │◄─yield chunk───────────┤
  │◄──SSE: chunk────────────│                         │
  │                         │◄─generator done────────┤
  │◄──SSE: finish───────────│                         │
```

### runCompletion Flow

```typescript
function runCompletion(agent: Agent, ...) {
  // Run asynchronously without blocking
  (async () => {
    try {
      // 1. Configure git user if provided
      await configureGitUser(gitUserName, gitUserEmail)

      // 2. Update environment if credentials changed
      if (credentialsChanged) {
        await agent.updateEnvironment({ env: credentialEnv })
      }

      // 3. Ensure agent is connected with session
      if (!agent.isConnected) await agent.connect()
      await agent.ensureSession(sessionId)

      // 4. Send start event
      addCompletionEvent({ type: "start", messageId: userMessage.id })

      // 5. Stream chunks from agent's async generator
      for await (const chunk of agent.prompt(userMessage, sessionId)) {
        addCompletionEvent(chunk)
      }

      // 6. Send finish event
      addCompletionEvent({ type: "finish" })
      await finishCompletion()
    } catch (error) {
      addCompletionEvent({ type: "error", errorText: error.message })
      await finishCompletion(error.message)
    }
  })()
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

### Completion Conflict

```typescript
if (isCompletionRunning()) {
  return c.json({
    error: 'completion_in_progress',
    completionId: existingId
  }, 409)
}
```

### Stream Errors

Errors during completion are sent as SSE events:

```typescript
} catch (error) {
  addCompletionEvent({
    type: 'error',
    errorText: error.message
  })
}
```

## Server Bootstrap

### index.ts

```typescript
import { serve } from '@hono/node-server'
import { createApp } from './server/app'
import { ClaudeSDKClient } from './claude-sdk/client'

// Create agent
const agent = new ClaudeSDKClient({
  cwd: process.env.CWD ?? process.cwd(),
  model: process.env.MODEL,
  env: { /* credentials */ }
})

// Create application
const app = createApp({ agent })

// Start server
const port = parseInt(process.env.PORT ?? '3001')
serve({ fetch: app.fetch, port })

console.log(`Agent server running on port ${port}`)
```

## Testing

The server is tested via:
- Unit tests for route handlers
- Integration tests with mock Agent
- E2E tests with real Claude CLI

```typescript
// test/e2e.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert'

describe('POST /chat', () => {
  it('starts completion', async () => {
    const response = await fetch('http://localhost:3001/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [...] })
    })

    assert.strictEqual(response.status, 202)
    const body = await response.json()
    assert.ok(body.completionId)
  })
})
```
