# Agent Interface

The Agent interface provides an abstraction layer over different agent implementations, allowing the agent-api to work with Claude SDK and potentially other agent types.

## Overview

The Agent interface abstracts away the protocol details, making it possible to:

1. Support different agent implementations
2. Swap out agent implementations without changing the rest of the codebase
3. Use a consistent streaming interface (async generators)

## Interface Definition

The Agent interface uses AI SDK types (UIMessage, UIMessageChunk) to remain implementation-agnostic:

```typescript
export interface Agent {
  // Connection management
  connect(): Promise<void>;
  ensureSession(sessionId?: string): Promise<string>;
  disconnect(): Promise<void>;
  get isConnected(): boolean;

  // Messaging - returns an async generator of chunks
  prompt(message: UIMessage, sessionId?: string): AsyncGenerator<UIMessageChunk, void, unknown>;
  cancel(sessionId?: string): Promise<void>;

  // Environment
  updateEnvironment(update: EnvironmentUpdate): Promise<void>;
  getEnvironment(): Record<string, string>;

  // Session management
  getSession(sessionId?: string): Session | undefined;
  listSessions(): string[];
  createSession(sessionId: string): Session;
  clearSession(sessionId?: string): Promise<void>;
}
```

### Methods

**Connection Management:**
- **`connect()`**: Establish a connection to the agent. For Claude SDK, this finds the Claude CLI binary.
- **`ensureSession(sessionId?)`**: Ensure a session exists, creating a new one or resuming an existing session. Returns the session ID.
- **`disconnect()`**: Clean up resources and disconnect from the agent.
- **`isConnected`**: Check if the agent is currently connected.

**Messaging:**
- **`prompt(message, sessionId?)`**: Send a UIMessage to the agent and receive an async generator of UIMessageChunk events. The caller iterates over the generator to receive streaming chunks.
- **`cancel(sessionId?)`**: Cancel the current operation.

**Environment:**
- **`updateEnvironment(update)`**: Update environment variables and restart the agent if connected.
- **`getEnvironment()`**: Get current environment variables.

**Session Management:**
- **`getSession(sessionId?)`**: Get a Session by ID for reading messages.
- **`listSessions()`**: List all session IDs.
- **`createSession(sessionId)`**: Create a new session with the given ID.
- **`clearSession(sessionId?)`**: Clear the session completely.

## Session Interface

Sessions are read-only views into message history:

```typescript
export interface Session {
  readonly id: string;
  getMessages(): UIMessage[];
  clearMessages(): void;
}
```

The Claude SDK handles all message persistence via JSONL files in `~/.claude/projects/`. The Session interface just reads these files.

## Key Design Principles

### 1. Protocol Agnostic

The interface uses **AI SDK types** (UIMessage, UIMessageChunk) rather than protocol-specific types. This means:

- **Implementations translate internally**: ClaudeSDKClient translates UIMessage → prompt text when sending, and SDK events → UIMessageChunk when streaming.
- **Clean boundaries**: The rest of the codebase only sees AI SDK types.

### 2. Async Generator Streaming

The `prompt()` method returns an async generator instead of using callbacks:

```typescript
// In completion.ts
for await (const chunk of agent.prompt(userMessage, sessionId)) {
  addCompletionEvent(chunk);
}
```

Benefits:
- **Cleaner control flow**: No callback setup/teardown
- **Natural backpressure**: Consumer controls iteration speed
- **Easy cleanup**: Generator cleanup happens automatically
- **Composable**: Can be transformed with async iteration utilities

### 3. Disk-Backed Sessions

Claude SDK handles all message persistence. Sessions are read-only views:

- **`getMessages()`**: Reads messages from Claude SDK JSONL files
- **No in-memory storage**: Fresh reads from disk each time
- **ID mapping**: Maps discobot session IDs to Claude SDK session IDs

## Claude SDK Implementation

The `ClaudeSDKClient` class implements the `Agent` interface:

- **Protocol translation**: UIMessage → prompt text, SDK events → UIMessageChunk
- **CLI discovery**: Finds the Claude CLI on PATH or via `CLAUDE_CLI_PATH` env var
- **Session persistence**: Maintains mapping between discobot and Claude SDK session IDs
- **Message loading**: Reads messages from `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
- **Auto-approval**: Automatically approves tool permission requests

### SDK Message Types

The Claude SDK streams various message types that get translated to UIMessageChunk:

| SDK Event | UIMessageChunk Type |
|-----------|---------------------|
| `message_start` | `start` |
| `content_block_start` (text) | `text-start` |
| `content_block_delta` (text) | `text-delta` |
| `content_block_stop` (text) | `text-end` |
| `content_block_start` (thinking) | `reasoning-start` |
| `content_block_delta` (thinking) | `reasoning-delta` |
| `content_block_stop` (thinking) | `reasoning-end` |
| `content_block_start` (tool_use) | `tool-input-start` |
| `content_block_delta` (tool_use) | `tool-input-delta` |
| `content_block_stop` (tool_use) | `tool-input-available` |
| `tool_result` | `tool-output-available` or `tool-output-error` |
| `message_stop` | `finish` |

## Configuration

The Claude SDK client accepts these options:

```typescript
interface ClaudeSDKClientOptions {
  cwd: string;           // Working directory for the agent
  model?: string;        // Model to use (e.g., "claude-sonnet-4-5-20250929")
  env?: Record<string, string>;  // Environment variables
}
```

Claude CLI location can be configured via:
- `CLAUDE_CLI_PATH` environment variable
- Automatic PATH discovery
- Common installation locations (`~/.local/bin/claude`, `/usr/local/bin/claude`, etc.)

## Usage in App

The `createApp()` function accepts an `Agent` implementation:

```typescript
export function createApp(options: AppOptions) {
  const agent: Agent = new ClaudeSDKClient({
    cwd: options.cwd,
    model: options.model,
    env: options.env,
  });

  // ... use agent throughout the app
}
```

## Adding New Agent Implementations

To add a new agent implementation:

1. Create a new class that implements the `Agent` interface
2. Implement all required methods
3. Return an async generator from `prompt()` that yields UIMessageChunk events
4. Handle session management appropriate to your protocol
5. Instantiate your implementation in `createApp()` instead of `ClaudeSDKClient`

Example:

```typescript
class HttpAgent implements Agent {
  constructor(private baseUrl: string) {}

  async connect(): Promise<void> {
    // Establish HTTP connection
  }

  async *prompt(message: UIMessage, sessionId?: string): AsyncGenerator<UIMessageChunk> {
    // Send request to HTTP API
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });

    // Stream SSE events and yield chunks
    const reader = response.body!.getReader();
    // ... parse and yield UIMessageChunk events
  }

  // ... implement other methods
}
```

## Design Decisions

### Translation Flow

**Sending a prompt:**
```
UIMessage (AI SDK)
  → Agent.prompt(message)
  → ClaudeSDKClient: messageToPrompt(message)
  → string prompt
  → Claude SDK query() call
```

**Receiving updates (via async generator):**
```
SDKMessage (Claude SDK)
  → ClaudeSDKClient.translateSDKMessage()
  → UIMessageChunk[] (AI SDK)
  → yielded to caller
  → addCompletionEvent(chunk)  # Forwards to SSE
```

## Benefits

1. **Decoupling**: The app no longer depends on implementation details
2. **Flexibility**: Easy to add new agent types
3. **Testability**: Easy to create mock agents for testing
4. **Clean streaming**: Async generators provide natural streaming interface

## Related Modules

- [Server Module](./server.md) - Uses the Agent interface for completion handling
- [Store Module](./store.md) - Manages session state and completion events
