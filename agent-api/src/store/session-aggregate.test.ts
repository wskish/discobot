import assert from "node:assert";
import { describe, it } from "node:test";
import type { UIMessageChunk } from "ai";
import { aggregateDeltas } from "./session.js";

describe("aggregateDeltas", () => {
	it("should combine consecutive text-delta chunks with same id", () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-1" },
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", delta: "Hello" },
			{ type: "text-delta", id: "text-1", delta: " " },
			{ type: "text-delta", id: "text-1", delta: "world" },
			{ type: "text-end", id: "text-1" },
			{ type: "finish" },
		];

		const result = aggregateDeltas(chunks);

		assert.strictEqual(result.length, 5);
		assert.deepStrictEqual(result[0], { type: "start", messageId: "msg-1" });
		assert.deepStrictEqual(result[1], { type: "text-start", id: "text-1" });
		assert.deepStrictEqual(result[2], {
			type: "text-delta",
			id: "text-1",
			delta: "Hello world",
		});
		assert.deepStrictEqual(result[3], { type: "text-end", id: "text-1" });
		assert.deepStrictEqual(result[4], { type: "finish" });
	});

	it("should combine consecutive reasoning-delta chunks with same id", () => {
		const chunks: UIMessageChunk[] = [
			{ type: "reasoning-start", id: "reasoning-1" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: "Let me" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: " think" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: "..." },
			{ type: "reasoning-end", id: "reasoning-1" },
		];

		const result = aggregateDeltas(chunks);

		assert.strictEqual(result.length, 3);
		assert.deepStrictEqual(result[1], {
			type: "reasoning-delta",
			id: "reasoning-1",
			delta: "Let me think...",
		});
	});

	it("should combine consecutive tool-input-delta chunks with same toolCallId", () => {
		const chunks: UIMessageChunk[] = [
			{
				type: "tool-input-start",
				toolCallId: "tool-1",
				toolName: "bash",
				dynamic: true,
			},
			{
				type: "tool-input-delta",
				toolCallId: "tool-1",
				inputTextDelta: '{"command"',
			},
			{ type: "tool-input-delta", toolCallId: "tool-1", inputTextDelta: ":" },
			{
				type: "tool-input-delta",
				toolCallId: "tool-1",
				inputTextDelta: '"ls"}',
			},
			{
				type: "tool-input-available",
				toolCallId: "tool-1",
				toolName: "bash",
				input: { command: "ls" },
				dynamic: true,
			},
		];

		const result = aggregateDeltas(chunks);

		assert.strictEqual(result.length, 3);
		assert.deepStrictEqual(result[1], {
			type: "tool-input-delta",
			toolCallId: "tool-1",
			inputTextDelta: '{"command":"ls"}',
		});
	});

	it("should not combine deltas with different ids", () => {
		const chunks: UIMessageChunk[] = [
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", delta: "First" },
			{ type: "text-end", id: "text-1" },
			{ type: "text-start", id: "text-2" },
			{ type: "text-delta", id: "text-2", delta: "Second" },
			{ type: "text-end", id: "text-2" },
		];

		const result = aggregateDeltas(chunks);

		// Should have both deltas separate since they have different IDs
		assert.strictEqual(result.length, 6);
		assert.deepStrictEqual(result[1], {
			type: "text-delta",
			id: "text-1",
			delta: "First",
		});
		assert.deepStrictEqual(result[4], {
			type: "text-delta",
			id: "text-2",
			delta: "Second",
		});
	});

	it("should handle empty chunks array", () => {
		const result = aggregateDeltas([]);
		assert.strictEqual(result.length, 0);
	});

	it("should handle chunks with no deltas", () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-1" },
			{ type: "text-start", id: "text-1" },
			{ type: "text-end", id: "text-1" },
			{ type: "finish" },
		];

		const result = aggregateDeltas(chunks);
		assert.deepStrictEqual(result, chunks);
	});

	it("should combine deltas across multiple blocks", () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-1" },
			// First text block
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", delta: "A" },
			{ type: "text-delta", id: "text-1", delta: "B" },
			{ type: "text-end", id: "text-1" },
			// Reasoning block
			{ type: "reasoning-start", id: "reasoning-1" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: "X" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: "Y" },
			{ type: "reasoning-delta", id: "reasoning-1", delta: "Z" },
			{ type: "reasoning-end", id: "reasoning-1" },
			// Second text block
			{ type: "text-start", id: "text-2" },
			{ type: "text-delta", id: "text-2", delta: "C" },
			{ type: "text-delta", id: "text-2", delta: "D" },
			{ type: "text-end", id: "text-2" },
			{ type: "finish" },
		];

		const result = aggregateDeltas(chunks);

		assert.strictEqual(result.length, 11);
		// First text block aggregated
		assert.deepStrictEqual(result[2], {
			type: "text-delta",
			id: "text-1",
			delta: "AB",
		});
		// Reasoning block aggregated
		assert.deepStrictEqual(result[5], {
			type: "reasoning-delta",
			id: "reasoning-1",
			delta: "XYZ",
		});
		// Second text block aggregated
		assert.deepStrictEqual(result[8], {
			type: "text-delta",
			id: "text-2",
			delta: "CD",
		});
	});
});
