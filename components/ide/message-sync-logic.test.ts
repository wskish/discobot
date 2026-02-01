// Test the core logic of the message sync behavior
// This tests the logic that determines when setMessages should be called

import assert from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

// Simulates the logic in ChatPanel lines 209-221
function shouldSyncMessages(
	resume: boolean,
	swrMessages: UIMessage[],
	prevSwrMessages: UIMessage[],
): boolean {
	if (!resume || swrMessages.length === 0) {
		return false;
	}

	// Check if swrMessages actually changed by comparing with previous value
	const swrMessagesChanged =
		swrMessages.length !== prevSwrMessages.length ||
		swrMessages.some((msg, i) => msg.id !== prevSwrMessages[i]?.id);

	return swrMessagesChanged;
}

describe("Message Sync Logic", () => {
	const staleMessages: UIMessage[] = [
		{
			id: "1",
			role: "user",
			parts: [{ type: "text", text: "Stale message 1" }],
		},
		{
			id: "2",
			role: "assistant",
			parts: [{ type: "text", text: "Stale message 2" }],
		},
	];

	const freshMessages: UIMessage[] = [
		{
			id: "1",
			role: "user",
			parts: [{ type: "text", text: "Fresh message 1" }],
		},
		{
			id: "2",
			role: "assistant",
			parts: [{ type: "text", text: "Fresh message 2" }],
		},
		{
			id: "3",
			role: "user",
			parts: [{ type: "text", text: "New message 3" }],
		},
	];

	it("should sync when messages change (length increased)", () => {
		// Simulates: SWR refetches and gets more messages
		const result = shouldSyncMessages(true, freshMessages, staleMessages);
		assert.strictEqual(
			result,
			true,
			"Should sync when message count increases from 2 to 3",
		);
	});

	it("should sync when messages change (same length, different IDs)", () => {
		const differentMessages: UIMessage[] = [
			{
				id: "1",
				role: "user",
				parts: [{ type: "text", text: "Message 1" }],
			},
			{
				id: "999", // Different ID
				role: "assistant",
				parts: [{ type: "text", text: "Different message" }],
			},
		];

		const result = shouldSyncMessages(true, differentMessages, staleMessages);
		assert.strictEqual(result, true, "Should sync when message IDs differ");
	});

	it("should NOT sync when messages are the same", () => {
		// Same messages, no change
		const result = shouldSyncMessages(true, staleMessages, staleMessages);
		assert.strictEqual(
			result,
			false,
			"Should NOT sync when messages haven't changed",
		);
	});

	it("should NOT sync for new sessions (resume=false)", () => {
		// For new sessions, we don't sync from SWR
		const result = shouldSyncMessages(false, freshMessages, staleMessages);
		assert.strictEqual(result, false, "Should NOT sync for new sessions");
	});

	it("should NOT sync when swrMessages is empty", () => {
		const result = shouldSyncMessages(true, [], staleMessages);
		assert.strictEqual(
			result,
			false,
			"Should NOT sync when swrMessages is empty",
		);
	});

	it("demonstrates the bug scenario", () => {
		// THE BUG SCENARIO (before the fix):
		// 1. Component mounts with initialMessages = staleMessages (2 items)
		// 2. useChat initializes with these 2 messages
		// 3. invalidateMessages() triggers SWR refetch
		// 4. SWR returns freshMessages (3 items)
		// 5. WITHOUT the fix: useChat never updates, continues showing 2 stale messages
		// 6. WITH the fix: effect detects change and calls setMessages(freshMessages)

		// Initial state: prevSwrMessages = [] (empty ref)
		const initialPrev: UIMessage[] = [];

		// First effect run: swrMessages = staleMessages (from SWR cache)
		const shouldSync1 = shouldSyncMessages(true, staleMessages, initialPrev);
		assert.strictEqual(
			shouldSync1,
			true,
			"First run: should sync stale messages (prev was empty)",
		);

		// After first sync, prev = staleMessages
		// Second effect run: swrMessages = freshMessages (after refetch)
		const shouldSync2 = shouldSyncMessages(true, freshMessages, staleMessages);
		assert.strictEqual(
			shouldSync2,
			true,
			"Second run: should sync fresh messages (changed from stale)",
		);

		// This validates that the fix correctly detects the transition from
		// stale to fresh messages and triggers setMessages()
	});
});
