// Test the core logic of the message sync behavior
// This tests the logic that determines when setMessages should be called

import assert from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

// Simulates the logic in ChatPanel lines 206-231
function shouldSyncMessages(
	resume: boolean,
	swrMessages: UIMessage[],
	prevSwrMessages: UIMessage[],
	useChatMessages: UIMessage[], // Messages from useChat hook
): boolean {
	if (!resume || swrMessages.length === 0) {
		return false;
	}

	// Check if the last SWR message exists in useChat messages
	// If it does, useChat is already up-to-date (or ahead with streaming content)
	const lastSwrMessage = swrMessages[swrMessages.length - 1];
	const lastSwrMessageExistsInUseChat = useChatMessages.some(
		(msg) => msg.id === lastSwrMessage.id,
	);

	// Check if swrMessages actually changed by comparing with previous value
	const swrMessagesChanged =
		swrMessages.length !== prevSwrMessages.length ||
		swrMessages.some((msg, i) => msg.id !== prevSwrMessages[i]?.id);

	// Only sync if swrMessages changed AND the last message doesn't exist in useChat yet
	return swrMessagesChanged && !lastSwrMessageExistsInUseChat;
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

	it("should sync when messages change (length increased) and last message not in useChat", () => {
		// Simulates: SWR refetches and gets more messages, useChat doesn't have them yet
		const useChatMessages = staleMessages; // useChat still has old messages
		const result = shouldSyncMessages(
			true,
			freshMessages,
			staleMessages,
			useChatMessages,
		);
		assert.strictEqual(
			result,
			true,
			"Should sync when message count increases from 2 to 3 and useChat doesn't have new message",
		);
	});

	it("should sync when messages change (same length, different IDs) and last message not in useChat", () => {
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

		const useChatMessages = staleMessages; // useChat still has old messages
		const result = shouldSyncMessages(
			true,
			differentMessages,
			staleMessages,
			useChatMessages,
		);
		assert.strictEqual(
			result,
			true,
			"Should sync when message IDs differ and useChat doesn't have new message",
		);
	});

	it("should NOT sync when messages are the same", () => {
		// Same messages, no change
		const useChatMessages = staleMessages;
		const result = shouldSyncMessages(
			true,
			staleMessages,
			staleMessages,
			useChatMessages,
		);
		assert.strictEqual(
			result,
			false,
			"Should NOT sync when messages haven't changed",
		);
	});

	it("should NOT sync for new sessions (resume=false)", () => {
		// For new sessions, we don't sync from SWR
		const useChatMessages = staleMessages;
		const result = shouldSyncMessages(
			false,
			freshMessages,
			staleMessages,
			useChatMessages,
		);
		assert.strictEqual(result, false, "Should NOT sync for new sessions");
	});

	it("should NOT sync when swrMessages is empty", () => {
		const useChatMessages = staleMessages;
		const result = shouldSyncMessages(true, [], staleMessages, useChatMessages);
		assert.strictEqual(
			result,
			false,
			"Should NOT sync when swrMessages is empty",
		);
	});

	it("should NOT sync when useChat already has the last SWR message (streaming scenario)", () => {
		// This is the KEY fix for the streaming bug:
		// SWR has [1, 2, 3], but useChat has [1, 2, 3, 4-streaming]
		// The last SWR message (3) exists in useChat, so we DON'T sync
		// This prevents clobbering the streaming message (4)
		const swrMessagesWithThree = [
			{
				id: "1",
				role: "user",
				parts: [{ type: "text", text: "Message 1" }],
			},
			{
				id: "2",
				role: "assistant",
				parts: [{ type: "text", text: "Message 2" }],
			},
			{
				id: "3",
				role: "user",
				parts: [{ type: "text", text: "Message 3" }],
			},
		] as UIMessage[];

		const useChatMessagesWithStreaming = [
			...swrMessagesWithThree,
			{
				id: "4",
				role: "assistant",
				parts: [{ type: "text", text: "Streaming response..." }],
			},
		] as UIMessage[];

		const prevSwrMessages = swrMessagesWithThree.slice(0, 2); // Previous state had [1, 2]

		const result = shouldSyncMessages(
			true,
			swrMessagesWithThree,
			prevSwrMessages,
			useChatMessagesWithStreaming,
		);

		assert.strictEqual(
			result,
			false,
			"Should NOT sync when useChat already has the last SWR message (would clobber streaming)",
		);
	});

	it("demonstrates the original stale cache bug scenario", () => {
		// THE ORIGINAL BUG SCENARIO (from commit 696c693):
		// 1. Component mounts with initialMessages = staleMessages (2 items)
		// 2. useChat initializes with these 2 messages
		// 3. invalidateMessages() triggers SWR refetch
		// 4. SWR returns freshMessages (3 items)
		// 5. WITHOUT the original fix: useChat never updates, continues showing 2 stale messages
		// 6. WITH the fix: effect detects change and calls setMessages(freshMessages)

		// Initial state: prevSwrMessages = [] (empty ref)
		const initialPrev: UIMessage[] = [];

		// First effect run: swrMessages = staleMessages (from SWR cache)
		// useChat also has staleMessages (both initialized with same data)
		// Since useChat already has the last message, we DON'T sync (no-op, already in sync)
		const shouldSync1 = shouldSyncMessages(
			true,
			staleMessages,
			initialPrev,
			staleMessages,
		);
		assert.strictEqual(
			shouldSync1,
			false,
			"First run: should NOT sync when useChat already has same messages",
		);

		// After refetch, swrMessages = freshMessages (3 items)
		// useChat still has staleMessages (2 items)
		// The last fresh message (id=3) doesn't exist in useChat, so we SHOULD sync
		const shouldSync2 = shouldSyncMessages(
			true,
			freshMessages,
			staleMessages,
			staleMessages,
		);
		assert.strictEqual(
			shouldSync2,
			true,
			"Second run: should sync fresh messages (new message not in useChat)",
		);

		// This validates that the fix correctly detects when SWR has newer data
		// than useChat and triggers setMessages() to sync them
	});
});
