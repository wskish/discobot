# Claude Agent SDK Implementation

This document describes the implementation of the Claude Agent SDK v1 client for the agent-api service.

## Overview

The `ClaudeSDKClient` provides an alternative implementation of the `Agent` interface using the Claude Agent SDK v1 TypeScript API instead of spawning a child ACP process. This gives direct programmatic access to Claude Code's capabilities.

## Architecture

### Directory Structure

```
agent-api/src/claude-sdk/
├── client.ts        # ClaudeSDKClient class (implements Agent interface)
├── translate.ts     # SDK message → UIMessageChunk translation
└── types.ts         # TypeScript types for SDK-specific data structures
```

### Key Design Decisions

1. **Agent Type Selection**: The implementation coexists with `ACPClient`. Users can switch between implementations using the `AGENT_TYPE=claude-sdk` environment variable.

2. **Session Management**: The SDK manages its own session files in `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. We maintain a mapping between our session IDs and the SDK's session IDs for continuity.

3. **One query() per prompt()**: Each `prompt()` call creates a new SDK `query()` with session resumption via `options.resume`.

4. **SDK Presets**: We use `tools: { type: 'preset', preset: 'claude_code' }` and `systemPrompt: { type: 'preset', preset: 'claude_code' }` for consistency with Claude Code behavior.

5. **Reuse Existing Code**: We reuse `SessionImpl` from ACP, and the streaming utilities from `server/stream.ts`.

## Implementation Details

### Session Context

Each session maintains a `SessionContext`:

```typescript
interface SessionContext {
  sessionId: string;              // Our session ID
  claudeSessionId: string | null; // SDK's session ID (UUID)
  session: SessionImpl;           // Message storage
  callback: AgentUpdateCallback | null;  // Streaming callback
  streamState: StreamState | null;       // Translation state
  blockIds: StreamBlockIds | null;       // Block ID generation
}
```

### Message Translation

The SDK yields `SDKMessage` types that we translate to `UIMessageChunk`:

| SDK Message Type | Translation |
|------------------|-------------|
| `SDKSystemMessage` (init) | Capture `session_id`, no chunks |
| `SDKUserMessage` | No chunks (we already have this) |
| `SDKAssistantMessage` | text-start, text-delta, text-end chunks |
| `SDKPartialAssistantMessage` | Incremental streaming chunks |
| `SDKResultMessage` | finish chunk |

### Tool Handling

The SDK uses Anthropic's `ToolUseBlock` format. We translate to `DynamicToolUIPart`:

**Tool States:**
- `input-streaming` → Tool is being prepared
- `input-available` → Tool input is ready
- `output-available` → Tool executed successfully
- `output-error` → Tool failed with error

**Streaming Events:**
1. `content_block_start` with `tool_use` → `tool-input-start` chunk emitted
2. `input_json_delta` events → Accumulated to build complete tool input
3. `content_block_stop` → `tool-input-available` chunk emitted with complete input
4. `PostToolUse` hook fires → `tool-output-available` chunk emitted with tool result

**Permission Handling:**

We use `canUseTool` callback to auto-approve all tool executions while capturing their I/O:
- Returns `{ behavior: "allow" }` for all tools
- Allows hooks to fire (unlike `bypassPermissions` mode)
- `PostToolUse` hook captures `tool_response` (generic `unknown` type)
- Tool outputs are tool-specific structures (Bash has `stdout`/`stderr`, Read has `file`/`content`, etc.)

**Input Capture:**

Tool inputs are streamed as JSON deltas and accumulated:
- Initial `tool_use` block has empty input `{}`
- `input_json_delta` events provide partial JSON strings
- We accumulate in `inputJsonBuffer` and parse when complete
- Final parsed input is sent in `tool-input-available` chunk

### Configuration

**Options:**

```typescript
interface ClaudeSDKClientOptions {
  cwd: string;
  model?: string;
  env?: Record<string, string>;
}
```

**Note**: Session persistence is always enabled for Claude SDK. Sessions are automatically loaded from and saved to `~/.claude/projects/<encoded-cwd>/` on every interaction.

**SDK Options Passed:**

```typescript
{
  cwd: options.cwd,
  model: options.model || "claude-sonnet-4-5-20250929",
  resume: claudeSessionId || undefined,
  env: this.env,
  includePartialMessages: true,
  tools: { type: "preset", preset: "claude_code" },
  systemPrompt: { type: "preset", preset: "claude_code" },
  settingSources: ["project"], // Load CLAUDE.md files
  maxThinkingTokens: 10000, // Enable extended thinking
  pathToClaudeCodeExecutable: <discovered-path>,
  canUseTool: async (toolName, input, options) => {
    // Auto-approve all tools while capturing execution
    return { behavior: "allow", toolUseID: options.toolUseID };
  },
  hooks: {
    PostToolUse: [/* Capture tool output after execution */]
  }
}
```

**Claude CLI Discovery:**

The SDK spawns a Claude Code CLI process to handle agent execution. The path is automatically discovered:

1. **Environment Variable**: `CLAUDE_CLI_PATH` (highest priority)
2. **PATH Search**: Checks each directory in `PATH` environment variable for executable `claude` binary
3. **Common Locations**: Fallback to `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`
4. **Error on Failure**: Throws error if CLI cannot be found

Discovery uses Node's `fs.access()` with `X_OK` flag to verify the binary exists and is executable.

**Installation:**
- **Local Development**: `curl -fsSL https://claude.ai/install.sh | bash` (installs to `~/.local/bin/claude`)
- **Docker**: Automatically included in container image at `/usr/local/bin/claude`
- **Custom Path**: Set `CLAUDE_CLI_PATH=/path/to/claude` to override discovery

## Usage

### Environment Variables

- `AGENT_TYPE` - Agent implementation to use: `claude-sdk` (default) or `acp`
- `AGENT_MODEL=claude-sonnet-4-5-20250929` - Model selection (optional, defaults to Claude Sonnet 4.5)
- `ANTHROPIC_API_KEY` - Required for SDK authentication
- `CLAUDE_CLI_PATH` - Optional path to Claude CLI binary (auto-discovered if not set)

**Note**: Session persistence is always enabled for Claude SDK and cannot be disabled. All sessions are automatically saved to and loaded from `~/.claude/projects/`.

### Starting the Server

```bash
# Default configuration (uses Claude SDK)
ANTHROPIC_API_KEY=your-key-here pnpm dev

# With custom model
AGENT_MODEL=claude-opus-4-5-20251101 \
ANTHROPIC_API_KEY=your-key-here \
pnpm dev

# Use ACP instead (legacy)
AGENT_TYPE=acp pnpm dev
```

### HTTP API

The API remains unchanged - all endpoints work identically:

```bash
# Send a chat message
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "id": "msg-1",
      "role": "user",
      "parts": [{"type": "text", "text": "Read the README file"}]
    }]
  }'
```

## Comparison with ACP Implementation

| Feature | ACPClient | ClaudeSDKClient |
|---------|-----------|-----------------|
| **Connection** | Spawns child process | Direct SDK import |
| **Session Storage** | Custom `.jsonl` format | SDK's `~/.claude` format |
| **Message Protocol** | ACP ContentBlocks | Anthropic API format |
| **Tool Execution** | ACP tools | Claude SDK tools (preset) |
| **Resumption** | `unstable_resumeSession()` / `loadSession()` | `options.resume` |
| **Performance** | Process overhead | In-process (faster) |
| **Debugging** | Separate process | Same process (easier) |

## Session Persistence & Discovery

The implementation includes full support for reading and discovering sessions from the `~/.claude` directory:

### Session Discovery

```typescript
// Discover all available sessions for the current working directory
const sessions = await client.discoverAvailableSessions();

// Returns: ClaudeSessionInfo[]
// {
//   sessionId: "9a3b2231-2ed1-4974-b3ff-ae88fa5b6a47",
//   filePath: "/home/user/.claude/projects/-home-user-workspace/...",
//   cwd: "/home/user/workspace",
//   lastModified: Date,
//   messageCount: 520
// }
```

### Session Loading

When `persistMessages: true` (default), sessions are automatically loaded from `~/.claude`:

1. **Directory Structure**: Sessions are stored at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
2. **Path Encoding**: CWD paths are encoded (e.g., `/home/user/workspace` → `-home-user-workspace`)
3. **JSONL Format**: Each line is a JSON object representing messages, tools, and progress updates
4. **Automatic Loading**: On `ensureSession()`, the implementation checks for existing session files
5. **Message Reconstruction**: JSONL records are parsed and converted to UIMessage format

### Persistence Module

The `persistence.ts` module provides:

```typescript
// Discover sessions for a working directory
discoverSessions(cwd: string): Promise<ClaudeSessionInfo[]>

// Load messages from a session file
loadSessionMessages(sessionId: string, cwd: string): Promise<UIMessage[]>

// Get session metadata without loading all messages
getSessionMetadata(sessionId: string, cwd: string): Promise<ClaudeSessionInfo | null>

// Get the directory where sessions are stored
getSessionDirectoryForCwd(cwd: string): string
```

### Multi-Session Support

The implementation now supports multiple independent sessions:

- Each session has its own `SessionContext` with isolated state
- Sessions are lazily loaded on first access
- Session IDs can be any string (not restricted to "default")
- Messages, callbacks, and stream state are per-session

## Current Limitations

The implementation has the following limitations:

1. **No Streaming Tool Output**: Tool output arrives all at once after execution completes. The SDK doesn't provide hooks for streaming incremental output during tool execution (particularly for long-running Bash commands).

2. **Reasoning Support**: Extended thinking/reasoning is captured but not yet fully integrated into the UI message structure.

3. **No MCP Configuration**: MCP server configuration is not exposed in options.

4. **JSONL Parsing**: Currently parses only "user" and "assistant" type records. Progress updates, tool execution details, and other record types are not yet utilized.

## Future Enhancements

### Phase 4: Advanced Features

- Reasoning support (extract extended thinking)
- MCP server configuration
- Budget limits (maxTurns, maxBudgetUsd)
- File checkpointing for rewinding
- Custom tool configuration
- Parse and utilize additional JSONL record types (progress, hooks, etc.)

### Phase 4: Advanced Features

- Reasoning support (extract extended thinking)
- MCP server configuration
- Budget limits (maxTurns, maxBudgetUsd)
- File checkpointing for rewinding
- Custom tool configuration

## Testing

### Manual Testing

```bash
# 1. Basic query test
AGENT_TYPE=claude-sdk pnpm dev
# Send POST /chat with simple text message

# 2. Tool call test
# Send message: "Read package.json"
# Verify tool-input-start, tool-input-available, tool-output-available

# 3. Session resumption test
# Send first message
# Restart server
# Send second message in same session
# Verify history is preserved
```

### Unit Tests

Test files to create:
- `agent-api/src/claude-sdk/translate.test.ts` - Message translation
- `agent-api/src/claude-sdk/client.test.ts` - Client behavior

### Integration Tests

Add to `agent-api/test/integration/`:
- Full query/response flow
- Multi-turn conversation
- Tool execution
- Session persistence

## Troubleshooting

### Common Issues

**Error: "ANTHROPIC_API_KEY not set"**
- Solution: Set the `ANTHROPIC_API_KEY` environment variable

**Error: "Cannot find module @anthropic-ai/claude-agent-sdk"**
- Solution: Run `pnpm install` to install dependencies

**Sessions not resuming**
- Check that `~/.claude/projects/<encoded-cwd>/` contains `.jsonl` files
- Verify `claudeSessionId` is being captured from init message
- Ensure `options.resume` is being set correctly

**Tools not working**
- Verify tool events are being translated correctly
- Check tool state machine transitions
- Enable debug logging to see SDK messages
- Ensure `canUseTool` is returning `{ behavior: "allow" }`
- Check that `PostToolUse` hook is registered and firing

**Error: "Claude CLI not found"**
- Solution: Install Claude CLI or set `CLAUDE_CLI_PATH` environment variable
- Check PATH includes Claude installation directory
- Verify Claude CLI is executable: `test -x $(which claude)`

**Tool input is empty `{}`**
- This was fixed in the implementation - tool inputs are now accumulated from `input_json_delta` events
- Verify `inputJsonBuffer` is being updated in translate.ts
- Check that `lastRawInput` is parsed from the complete JSON buffer

## References

- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Session Management Guide](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [GitHub Repository](https://github.com/anthropics/claude-agent-sdk-typescript)
- [Agent Interface Documentation](./agent.md)
- [ACP Client Documentation](./acp.md)
