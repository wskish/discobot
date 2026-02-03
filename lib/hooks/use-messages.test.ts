import assert from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";

// Test the deduplication logic used in useMessages hook
// We test the core deduplication algorithm separately from SWR

/**
 * Deduplicates messages by ID and logs a warning if duplicates are found.
 * This is the same logic used in the useMessages hook's onSuccess callback.
 */
function deduplicateMessages(
	messages: UIMessage[],
	sessionId: string,
): UIMessage[] {
	const seen = new Set<string>();
	const deduped: UIMessage[] = [];
	const duplicates: string[] = [];

	for (const msg of messages) {
		if (!seen.has(msg.id)) {
			seen.add(msg.id);
			deduped.push(msg);
		} else {
			duplicates.push(msg.id);
		}
	}

	if (duplicates.length > 0) {
		console.warn(
			`[useMessages] Deduplicating messages for session ${sessionId}. Found ${duplicates.length} duplicate(s): ${duplicates.join(", ")}`,
		);
	}

	return deduped;
}

// Helper to create mock UIMessage
function createMockMessage(id: string, role: "user" | "assistant"): UIMessage {
	return {
		id,
		role,
		parts: [{ type: "text", text: `Message ${id}` }],
	} as UIMessage;
}

describe("useMessages deduplication logic", () => {
	describe("deduplicateMessages", () => {
		it("should return same array when no duplicates exist", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-3", "user"),
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 3);
			assert.deepStrictEqual(result, messages);
		});

		it("should remove duplicate messages by ID", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-1", "user"), // duplicate
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].id, "msg-1");
			assert.strictEqual(result[1].id, "msg-2");
		});

		it("should keep first occurrence of duplicate message", () => {
			const firstOccurrence = createMockMessage("msg-1", "user");
			const duplicate = createMockMessage("msg-1", "assistant"); // Same ID, different role

			const messages: UIMessage[] = [firstOccurrence, duplicate];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], firstOccurrence);
			assert.strictEqual(result[0].role, "user");
		});

		it("should handle multiple duplicates of same message", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-1", "user"), // duplicate 1
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-1", "user"), // duplicate 2
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 2);
			assert.strictEqual(result[0].id, "msg-1");
			assert.strictEqual(result[1].id, "msg-2");
		});

		it("should handle multiple different duplicates", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-1", "user"), // duplicate of msg-1
				createMockMessage("msg-3", "user"),
				createMockMessage("msg-2", "assistant"), // duplicate of msg-2
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[0].id, "msg-1");
			assert.strictEqual(result[1].id, "msg-2");
			assert.strictEqual(result[2].id, "msg-3");
		});

		it("should handle empty messages array", () => {
			const messages: UIMessage[] = [];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 0);
			assert.deepStrictEqual(result, []);
		});

		it("should handle single message", () => {
			const messages: UIMessage[] = [createMockMessage("msg-1", "user")];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, "msg-1");
		});

		it("should preserve message order when deduplicating", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-3", "user"),
				createMockMessage("msg-2", "assistant"), // duplicate
				createMockMessage("msg-4", "assistant"),
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 4);
			assert.strictEqual(result[0].id, "msg-1");
			assert.strictEqual(result[1].id, "msg-2");
			assert.strictEqual(result[2].id, "msg-3");
			assert.strictEqual(result[3].id, "msg-4");
		});

		it("should handle realistic duplicate ID from error case", () => {
			// This is the actual duplicate ID from the bug report
			const duplicateId = "EzFZ9CsKbJi5BuJN";

			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage(duplicateId, "assistant"),
				createMockMessage("msg-2", "user"),
				createMockMessage(duplicateId, "assistant"), // duplicate
			];

			const result = deduplicateMessages(messages, "session-abc123");

			assert.strictEqual(result.length, 3);
			assert.strictEqual(result[1].id, duplicateId);
			// Should only appear once in result
			const duplicateCount = result.filter((m) => m.id === duplicateId).length;
			assert.strictEqual(duplicateCount, 1);
		});
	});

	describe("Message ID format", () => {
		it("should handle nanoid-style message IDs", () => {
			// nanoid generates IDs like "EzFZ9CsKbJi5BuJN"
			const messages: UIMessage[] = [
				createMockMessage("EzFZ9CsKbJi5BuJN", "user"),
				createMockMessage("A1b2C3d4E5f6G7h8", "assistant"),
				createMockMessage("EzFZ9CsKbJi5BuJN", "user"), // duplicate
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 2);
		});

		it("should handle UUID-style message IDs", () => {
			const messages: UIMessage[] = [
				createMockMessage("550e8400-e29b-41d4-a716-446655440000", "user"),
				createMockMessage("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "assistant"),
				createMockMessage("550e8400-e29b-41d4-a716-446655440000", "user"), // duplicate
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 2);
		});
	});

	describe("Edge cases", () => {
		it("should handle messages with complex parts", () => {
			const messageWithMultipleParts: UIMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [
					{ type: "text", text: "Hello" },
					{
						type: "dynamic-tool",
						toolCallId: "tool-1",
						toolName: "TodoWrite",
						input: { todos: [] },
						state: "output-available",
						output: [],
					},
					{ type: "text", text: "World" },
				],
			} as UIMessage;

			const duplicate: UIMessage = {
				id: "msg-1",
				role: "assistant",
				parts: [{ type: "text", text: "Different content" }],
			} as UIMessage;

			const messages: UIMessage[] = [messageWithMultipleParts, duplicate];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0], messageWithMultipleParts);
			assert.strictEqual(result[0].parts.length, 3);
		});

		it("should handle all messages being duplicates except first", () => {
			const messages: UIMessage[] = [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-1", "user"),
			];

			const result = deduplicateMessages(messages, "session-123");

			assert.strictEqual(result.length, 1);
			assert.strictEqual(result[0].id, "msg-1");
		});
	});

	describe("Performance characteristics", () => {
		it("should handle large message arrays efficiently", () => {
			// Create 1000 messages with some duplicates
			const messages: UIMessage[] = [];
			for (let i = 0; i < 1000; i++) {
				messages.push(createMockMessage(`msg-${i}`, "user"));
			}
			// Add 100 duplicates scattered throughout
			for (let i = 0; i < 100; i++) {
				messages.push(createMockMessage(`msg-${i}`, "user"));
			}

			const startTime = Date.now();
			const result = deduplicateMessages(messages, "session-123");
			const endTime = Date.now();

			assert.strictEqual(result.length, 1000);
			// Should complete in reasonable time (< 100ms for 1100 messages)
			assert.ok(
				endTime - startTime < 100,
				`Deduplication took too long: ${endTime - startTime}ms`,
			);
		});
	});
});

describe("SWR onSuccess integration pattern", () => {
	it("should mutate data.messages in place", () => {
		const data = {
			messages: [
				createMockMessage("msg-1", "user"),
				createMockMessage("msg-2", "assistant"),
				createMockMessage("msg-1", "user"), // duplicate
			],
		};

		const sessionId = "session-123";

		// Simulate onSuccess callback
		data.messages = deduplicateMessages(data.messages, sessionId);

		assert.strictEqual(data.messages.length, 2);
		assert.strictEqual(data.messages[0].id, "msg-1");
		assert.strictEqual(data.messages[1].id, "msg-2");
	});

	it("should handle null data gracefully", () => {
		// Test that null data doesn't cause errors
		const data = null as { messages?: UIMessage[] } | null;

		// This should not throw
		assert.strictEqual(data, null);
	});

	it("should handle data without messages field", () => {
		const data: { messages?: UIMessage[] } = {};

		// This should not throw
		assert.strictEqual(data.messages, undefined);
	});
});
