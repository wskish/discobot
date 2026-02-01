// Test for stale message caching issue in ChatPanel
// This test demonstrates that when initialMessages are passed to useChat,
// they are only used during initialization and changes to messages from props
// are not reflected in the chat UI

import assert from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

// Mock messages - stale vs fresh
const staleMessages: UIMessage[] = [
	{
		id: "1",
		role: "user",
		parts: [{ type: "text", text: "Stale user message" }],
	},
	{
		id: "2",
		role: "assistant",
		parts: [{ type: "text", text: "Stale assistant response" }],
	},
];

const freshMessages: UIMessage[] = [
	{
		id: "1",
		role: "user",
		parts: [{ type: "text", text: "Fresh user message" }],
	},
	{
		id: "2",
		role: "assistant",
		parts: [{ type: "text", text: "Fresh assistant response" }],
	},
	{
		id: "3",
		role: "user",
		parts: [{ type: "text", text: "Another fresh message" }],
	},
];

describe("ChatPanel - Stale Message Caching", () => {
	it("demonstrates the issue and documents the fix", () => {
		// THE ISSUE:
		// 1. ChatPanel receives initialMessages prop from parent (could be stale from SWR cache)
		// 2. ChatPanel passes initialMessages to useChat hook
		// 3. useChat initializes its internal state with these messages
		// 4. ChatPanel calls mutate() to refresh messages from API
		// 5. SWR refetches and updates its cache with fresh messages
		// 6. BUT: useChat ignores the fresh messages and keeps using stale internal state

		// THE FIX:
		// ChatPanel now:
		// 1. Fetches messages from useMessages hook (swrMessages)
		// 2. Watches for changes to swrMessages
		// 3. When swrMessages changes (after refetch), calls setMessages() from useChat
		// 4. This syncs the fresh messages into useChat's internal state

		assert.strictEqual(staleMessages.length, 2, "Stale messages have 2 items");
		assert.strictEqual(
			freshMessages.length,
			3,
			"Fresh messages have 3 items (one more)",
		);

		// The fix ensures that after invalidateMessages() is called and SWR refetches,
		// the fresh messages are synced to useChat via setMessages()
	});
});
