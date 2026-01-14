# Chat Module

The chat module handles AI conversations using the Vercel AI SDK v5, providing streaming responses and custom UI elements.

## Files

| File | Description |
|------|-------------|
| `components/ide/chat-panel.tsx` | Main chat interface component |
| `components/ai-elements/conversation.tsx` | Message list container |
| `components/ai-elements/message.tsx` | Individual message renderer |
| `components/ai-elements/prompt-input.tsx` | Chat input with attachments |
| `lib/hooks/use-messages.ts` | SWR hook for message history |

## Architecture

### Chat Flow

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   ChatPanel     │───▶│   Go Backend    │───▶│   Container     │
│   (useChat)     │    │   /api/chat     │    │   /chat         │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                      │                      │
        │◀─────────── SSE Stream ◀────────────────────│
```

### Message Types

The chat uses Vercel AI SDK's `UIMessage` format:

```typescript
interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  parts: UIPart[]
  createdAt?: Date
}

type UIPart =
  | TextUIPart
  | ReasoningUIPart
  | ToolInvocationUIPart
  | FileUIPart
```

## ChatPanel Component

The main chat interface at `components/ide/chat-panel.tsx`:

### Props

```typescript
interface ChatPanelProps {
  session: Session | null
  workspaceId: string | null
  agentId: string | null
  onSessionCreated?: (sessionId: string) => void
}
```

### useChat Integration

```typescript
const { messages, input, handleSubmit, isLoading, setInput } = useChat({
  api: '/api/chat',
  body: {
    workspaceId,
    agentId,
    sessionId: session?.id,
  },
  onFinish: (message) => {
    // Handle completion
  },
  onError: (error) => {
    // Handle error
  },
})
```

### Features

1. **Streaming Responses**: Messages stream in real-time via SSE
2. **Tool Invocations**: Tool calls displayed with status (pending, running, complete)
3. **Reasoning Display**: Model reasoning/thinking shown in collapsible sections
4. **File Attachments**: Support for attaching files to messages
5. **Mode/Model Selection**: Dropdown to select agent mode and model

## AI Elements

### Conversation Component

Renders the message list with auto-scroll:

```tsx
<Conversation
  messages={messages}
  isLoading={isLoading}
  renderMessage={(message) => <Message message={message} />}
/>
```

Features:
- Auto-scroll to bottom on new messages
- Loading indicator during streaming
- Empty state when no messages

### Message Component

Renders individual messages with parts:

```tsx
<Message message={message} />
```

Handles different part types:
- **Text**: Rendered as markdown
- **Reasoning**: Collapsible thinking section
- **Tool Invocation**: Tool name, input, output display
- **Files**: Linked file references

### PromptInput Component

Chat input with features:

```tsx
<PromptInput
  value={input}
  onChange={setInput}
  onSubmit={handleSubmit}
  isLoading={isLoading}
  disabled={!session}
/>
```

Features:
- Multi-line input with shift+enter
- Submit on enter
- File attachment button
- Disabled state when loading

## Session Creation

When a user sends a message without an active session:

1. `ChatPanel` detects no session
2. POST `/api/chat` includes `workspaceId` and `agentId`
3. Go backend creates session record
4. Go backend starts container
5. Response includes `sessionId` in metadata
6. `onSessionCreated` callback updates parent state

## Message History

The `useMessages` hook fetches message history for existing sessions:

```typescript
const { messages, isLoading, error } = useMessages(sessionId)
```

Implementation:
- Calls `GET /api/projects/{projectId}/sessions/{sessionId}/messages`
- Returns cached messages from SWR
- Container returns stored messages

## Styling

Chat uses design tokens for theming:

```css
/* Message bubbles */
.bg-muted { background: var(--muted); }
.text-muted-foreground { color: var(--muted-foreground); }

/* Tool invocations */
.bg-accent { background: var(--accent); }
.border-border { border-color: var(--border); }
```

## Error Handling

Errors are displayed inline:
- Network errors: Toast notification
- Streaming errors: Error message in chat
- Validation errors: Input field validation

## Integration Points

- **Go Backend**: Proxies chat to container via `/api/chat`
- **Container Agent**: Handles message routing to AI provider
- **useProjectEvents**: Receives session status updates
- **useSessions**: Updates session metadata on creation
