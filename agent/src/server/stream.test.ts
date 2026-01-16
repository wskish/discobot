import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { DynamicToolUIPart, UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import { sessionUpdateToUIPart } from "../acp/translate.js";
import {
	createBlockIds,
	createErrorChunk,
	createFinishChunks,
	createReasoningChunks,
	createStartChunk,
	createStreamState,
	createTextChunks,
	createToolChunks,
	partToChunks,
	type StreamablePart,
} from "./stream.js";

/**
 * Test fixture: a sequence of SessionUpdates and expected UIMessageChunks.
 */
interface StreamFixture {
	name: string;
	messageId: string;
	/** Input: sequence of SessionUpdates from ACP */
	sessionUpdates: SessionUpdate[];
	/** Expected: sequence of UIMessageChunks that should be emitted */
	expectedChunks: UIMessageChunk[];
}

/**
 * Helper to create a ReadableStream from an array of chunks.
 */
function chunksToStream(
	chunks: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
}

/**
 * Process SessionUpdates through the stream protocol and collect emitted chunks.
 */
function processSessionUpdates(
	sessionUpdates: SessionUpdate[],
	messageId: string,
): UIMessageChunk[] {
	const state = createStreamState();
	const ids = createBlockIds(messageId);
	const chunks: UIMessageChunk[] = [];

	// Start chunk
	chunks.push(createStartChunk(messageId));

	// Process each session update
	for (const update of sessionUpdates) {
		const part = sessionUpdateToUIPart(update);
		if (part) {
			chunks.push(...partToChunks(part as StreamablePart, state, ids));
		}
	}

	// Finish chunks
	chunks.push(...createFinishChunks(state, ids));

	return chunks;
}

describe("stream.ts", () => {
	describe("createStreamState", () => {
		it("creates initial state with null block IDs", () => {
			const state = createStreamState();

			assert.equal(state.currentTextBlockId, null);
			assert.equal(state.currentReasoningBlockId, null);
			assert.equal(state.textBlockCounter, 0);
			assert.equal(state.reasoningBlockCounter, 0);
			assert.equal(state.toolStates.size, 0);
		});
	});

	describe("createBlockIds", () => {
		it("creates container with messageId", () => {
			const ids = createBlockIds("msg-123");

			assert.equal(ids.messageId, "msg-123");
		});
	});

	describe("createStartChunk", () => {
		it("creates start chunk with messageId", () => {
			const chunk = createStartChunk("msg-456");

			assert.deepEqual(chunk, {
				type: "start",
				messageId: "msg-456",
			});
		});
	});

	describe("createTextChunks", () => {
		it("emits text-start before first delta with unique ID", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			const chunks = createTextChunks("Hello", state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], { type: "text-start", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], {
				type: "text-delta",
				id: "text-msg-1-1",
				delta: "Hello",
			});
			assert.equal(state.currentTextBlockId, "text-msg-1-1");
			assert.equal(state.textBlockCounter, 1);
		});

		it("only emits delta after first text (same block)", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// First chunk
			createTextChunks("Hello", state, ids);
			// Second chunk
			const chunks = createTextChunks(" World", state, ids);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "text-delta",
				id: "text-msg-1-1",
				delta: " World",
			});
		});

		it("closes reasoning and starts new text when switching", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Start reasoning
			createReasoningChunks("Thinking", state, ids);
			assert.equal(state.currentReasoningBlockId, "reasoning-msg-1-1");

			// Switch to text
			const chunks = createTextChunks("Answer", state, ids);

			// Should close reasoning, start text, emit delta
			assert.equal(chunks.length, 3);
			assert.deepEqual(chunks[0], {
				type: "reasoning-end",
				id: "reasoning-msg-1-1",
			});
			assert.deepEqual(chunks[1], { type: "text-start", id: "text-msg-1-1" });
			assert.deepEqual(chunks[2], {
				type: "text-delta",
				id: "text-msg-1-1",
				delta: "Answer",
			});
			assert.equal(state.currentReasoningBlockId, null);
			assert.equal(state.currentTextBlockId, "text-msg-1-1");
		});

		it("generates unique ID for each text block after tool interruption", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// First text block
			const chunks1 = createTextChunks("Before tool", state, ids);
			assert.equal(state.textBlockCounter, 1);
			assert.equal(state.currentTextBlockId, "text-msg-1-1");

			// Tool interrupts (closes text block)
			const toolPart: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "test",
				state: "input-available",
				input: {},
			};
			createToolChunks(toolPart, state);
			assert.equal(state.currentTextBlockId, null); // Text block closed

			// Second text block - should get NEW unique ID
			const chunks2 = createTextChunks("After tool", state, ids);
			assert.equal(state.textBlockCounter, 2);
			assert.equal(state.currentTextBlockId, "text-msg-1-2");

			// Verify the IDs are different
			const startChunk1 = chunks1.find((c) => c.type === "text-start");
			const startChunk2 = chunks2.find((c) => c.type === "text-start");
			assert.ok(startChunk1 && startChunk1.type === "text-start");
			assert.ok(startChunk2 && startChunk2.type === "text-start");
			assert.notEqual(startChunk1.id, startChunk2.id);
			assert.equal(startChunk1.id, "text-msg-1-1");
			assert.equal(startChunk2.id, "text-msg-1-2");
		});

		it("generates unique IDs for multiple text blocks", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const collectedIds: string[] = [];

			// Simulate text → tool → text → tool → text pattern
			for (let i = 0; i < 3; i++) {
				const chunks = createTextChunks(`Text block ${i + 1}`, state, ids);
				const startChunk = chunks.find((c) => c.type === "text-start");
				if (startChunk && startChunk.type === "text-start") {
					collectedIds.push(startChunk.id);
				}

				// Simulate tool closing the text block (except on last iteration)
				if (i < 2) {
					const toolPart: DynamicToolUIPart = {
						type: "dynamic-tool",
						toolCallId: `tc-${i}`,
						toolName: "test",
						state: "output-available",
						input: {},
						output: "done",
					};
					createToolChunks(toolPart, state);
				}
			}

			// Verify all IDs are unique
			assert.equal(collectedIds.length, 3);
			assert.equal(new Set(collectedIds).size, 3, "All IDs should be unique");
			assert.deepEqual(collectedIds, [
				"text-msg-1-1",
				"text-msg-1-2",
				"text-msg-1-3",
			]);
		});
	});

	describe("createReasoningChunks", () => {
		it("emits reasoning-start before first delta with unique ID", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			const chunks = createReasoningChunks("Thinking...", state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], {
				type: "reasoning-start",
				id: "reasoning-msg-1-1",
			});
			assert.deepEqual(chunks[1], {
				type: "reasoning-delta",
				id: "reasoning-msg-1-1",
				delta: "Thinking...",
			});
			assert.equal(state.currentReasoningBlockId, "reasoning-msg-1-1");
		});

		it("only emits delta after first reasoning (same block)", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			createReasoningChunks("First", state, ids);
			const chunks = createReasoningChunks("Second", state, ids);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "reasoning-delta",
				id: "reasoning-msg-1-1",
				delta: "Second",
			});
		});

		it("closes text and starts new reasoning when switching", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Start text
			createTextChunks("Hello", state, ids);

			// Switch to reasoning
			const chunks = createReasoningChunks("Thinking", state, ids);

			assert.equal(chunks.length, 3);
			assert.deepEqual(chunks[0], { type: "text-end", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], {
				type: "reasoning-start",
				id: "reasoning-msg-1-1",
			});
			assert.deepEqual(chunks[2], {
				type: "reasoning-delta",
				id: "reasoning-msg-1-1",
				delta: "Thinking",
			});
		});

		it("generates unique ID for each reasoning block after text interruption", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// First reasoning block
			const chunks1 = createReasoningChunks("Thinking 1", state, ids);
			assert.equal(state.reasoningBlockCounter, 1);
			assert.equal(state.currentReasoningBlockId, "reasoning-msg-1-1");

			// Text interrupts (closes reasoning block)
			createTextChunks("Response", state, ids);
			assert.equal(state.currentReasoningBlockId, null); // Reasoning block closed

			// Second reasoning block - should get NEW unique ID
			const chunks2 = createReasoningChunks("Thinking 2", state, ids);
			assert.equal(state.reasoningBlockCounter, 2);
			assert.equal(state.currentReasoningBlockId, "reasoning-msg-1-2");

			// Verify the IDs are different
			const startChunk1 = chunks1.find((c) => c.type === "reasoning-start");
			const startChunk2 = chunks2.find((c) => c.type === "reasoning-start");
			assert.ok(startChunk1 && startChunk1.type === "reasoning-start");
			assert.ok(startChunk2 && startChunk2.type === "reasoning-start");
			assert.notEqual(startChunk1.id, startChunk2.id);
			assert.equal(startChunk1.id, "reasoning-msg-1-1");
			assert.equal(startChunk2.id, "reasoning-msg-1-2");
		});
	});

	describe("createToolChunks", () => {
		it("closes open text block before tool and emits tool-input-start", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Start text
			createTextChunks("Let me check", state, ids);

			const toolPart: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-streaming",
				input: undefined,
			};

			const chunks = createToolChunks(toolPart, state);

			// Should close text, then emit tool-input-start
			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], { type: "text-end", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				dynamic: true,
			});
			assert.equal(state.currentTextBlockId, null);
		});

		it("emits tool-input-start on first encounter (no prior blocks)", () => {
			const state = createStreamState();
			const toolPart: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-streaming",
				input: undefined,
			};

			const chunks = createToolChunks(toolPart, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				dynamic: true,
			});
		});

		it("emits tool-input-available on state transition", () => {
			const state = createStreamState();

			// First: input-streaming
			const toolPart1: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-streaming",
				input: undefined,
			};
			createToolChunks(toolPart1, state);

			// Second: input-available
			const toolPart2: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-available",
				input: { path: "/test.txt" },
			};
			const chunks = createToolChunks(toolPart2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-input-available",
				toolCallId: "tc-1",
				toolName: "read_file",
				input: { path: "/test.txt" },
				dynamic: true,
			});
		});

		it("emits tool-output-available on completion", () => {
			const state = createStreamState();

			// Setup: input-available
			const toolPart1: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-available",
				input: { path: "/test.txt" },
			};
			createToolChunks(toolPart1, state);

			// Complete: output-available
			const toolPart2: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "output-available",
				input: { path: "/test.txt" },
				output: "file contents",
			};
			const chunks = createToolChunks(toolPart2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "file contents",
				dynamic: true,
			});
		});

		it("emits tool-output-error on failure", () => {
			const state = createStreamState();

			// Setup: input-available
			const toolPart1: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-available",
				input: { path: "/test.txt" },
			};
			createToolChunks(toolPart1, state);

			// Fail: output-error
			const toolPart2: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "output-error",
				input: { path: "/test.txt" },
				errorText: "File not found",
			};
			const chunks = createToolChunks(toolPart2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-error",
				toolCallId: "tc-1",
				errorText: "File not found",
				dynamic: true,
			});
		});

		it("does not emit duplicate events for same state", () => {
			const state = createStreamState();

			const toolPart: DynamicToolUIPart = {
				type: "dynamic-tool",
				toolCallId: "tc-1",
				toolName: "read_file",
				state: "input-available",
				input: { path: "/test.txt" },
			};

			// First call: should emit start + input-available
			const chunks1 = createToolChunks(toolPart, state);
			assert.equal(chunks1.length, 2);

			// Second call with same state: should emit nothing
			const chunks2 = createToolChunks(toolPart, state);
			assert.equal(chunks2.length, 0);
		});
	});

	describe("createFinishChunks", () => {
		it("emits only finish when no blocks started", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			const chunks = createFinishChunks(state, ids);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], { type: "finish" });
		});

		it("emits text-end before finish when text is open", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Open a text block
			createTextChunks("Hello", state, ids);

			const chunks = createFinishChunks(state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], { type: "text-end", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], { type: "finish" });
		});

		it("emits reasoning-end before finish when reasoning is open", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Open a reasoning block
			createReasoningChunks("Thinking", state, ids);

			const chunks = createFinishChunks(state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], {
				type: "reasoning-end",
				id: "reasoning-msg-1-1",
			});
			assert.deepEqual(chunks[1], { type: "finish" });
		});
	});

	describe("createErrorChunk", () => {
		it("creates error chunk with message", () => {
			const chunk = createErrorChunk("Something went wrong");

			assert.deepEqual(chunk, {
				type: "error",
				errorText: "Something went wrong",
			});
		});
	});
});

describe("stream fixtures", () => {
	const fixtures: StreamFixture[] = [
		{
			name: "simple text message",
			messageId: "msg-simple",
			sessionUpdates: [
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Hello" },
				},
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: " World" },
				},
			],
			expectedChunks: [
				{ type: "start", messageId: "msg-simple" },
				{ type: "text-start", id: "text-msg-simple-1" },
				{ type: "text-delta", id: "text-msg-simple-1", delta: "Hello" },
				{ type: "text-delta", id: "text-msg-simple-1", delta: " World" },
				{ type: "text-end", id: "text-msg-simple-1" },
				{ type: "finish" },
			],
		},
		{
			name: "text with reasoning (reasoning first)",
			messageId: "msg-reasoning",
			sessionUpdates: [
				{
					sessionUpdate: "agent_thought_chunk",
					content: { type: "text", text: "Let me think" },
				},
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "The answer is 42" },
				},
			],
			expectedChunks: [
				{ type: "start", messageId: "msg-reasoning" },
				{ type: "reasoning-start", id: "reasoning-msg-reasoning-1" },
				{
					type: "reasoning-delta",
					id: "reasoning-msg-reasoning-1",
					delta: "Let me think",
				},
				// Close reasoning before text
				{ type: "reasoning-end", id: "reasoning-msg-reasoning-1" },
				{ type: "text-start", id: "text-msg-reasoning-1" },
				{
					type: "text-delta",
					id: "text-msg-reasoning-1",
					delta: "The answer is 42",
				},
				{ type: "text-end", id: "text-msg-reasoning-1" },
				{ type: "finish" },
			],
		},
		{
			name: "text → tool → text (interleaved)",
			messageId: "msg-interleaved",
			sessionUpdates: [
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Let me check. " },
				},
				{
					sessionUpdate: "tool_call",
					toolCallId: "tc-read",
					title: "Read",
					status: "in_progress",
					rawInput: { path: "/file.txt" },
				},
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "tc-read",
					title: "Read",
					status: "completed",
					rawInput: { path: "/file.txt" },
					rawOutput: "contents",
				},
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Found it!" },
				},
			],
			expectedChunks: [
				{ type: "start", messageId: "msg-interleaved" },
				// First text block
				{ type: "text-start", id: "text-msg-interleaved-1" },
				{
					type: "text-delta",
					id: "text-msg-interleaved-1",
					delta: "Let me check. ",
				},
				// Close text before tool
				{ type: "text-end", id: "text-msg-interleaved-1" },
				// Tool
				{
					type: "tool-input-start",
					toolCallId: "tc-read",
					toolName: "Read",
					dynamic: true,
				},
				{
					type: "tool-input-available",
					toolCallId: "tc-read",
					toolName: "Read",
					input: { path: "/file.txt" },
					dynamic: true,
				},
				{
					type: "tool-output-available",
					toolCallId: "tc-read",
					output: "contents",
					dynamic: true,
				},
				// Second text block (NEW ID)
				{ type: "text-start", id: "text-msg-interleaved-2" },
				{
					type: "text-delta",
					id: "text-msg-interleaved-2",
					delta: "Found it!",
				},
				{ type: "text-end", id: "text-msg-interleaved-2" },
				{ type: "finish" },
			],
		},
		{
			name: "tool call with error",
			messageId: "msg-tool-error",
			sessionUpdates: [
				{
					sessionUpdate: "tool_call",
					toolCallId: "tc-fail",
					title: "Write",
					status: "in_progress",
					rawInput: { path: "/readonly.txt" },
				},
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "tc-fail",
					title: "Write",
					status: "failed",
					rawInput: { path: "/readonly.txt" },
					rawOutput: "Permission denied",
				},
			],
			expectedChunks: [
				{ type: "start", messageId: "msg-tool-error" },
				{
					type: "tool-input-start",
					toolCallId: "tc-fail",
					toolName: "Write",
					dynamic: true,
				},
				{
					type: "tool-input-available",
					toolCallId: "tc-fail",
					toolName: "Write",
					input: { path: "/readonly.txt" },
					dynamic: true,
				},
				{
					type: "tool-output-error",
					toolCallId: "tc-fail",
					errorText: "Permission denied",
					dynamic: true,
				},
				{ type: "finish" },
			],
		},
		{
			name: "empty message (no content)",
			messageId: "msg-empty",
			sessionUpdates: [],
			expectedChunks: [
				{ type: "start", messageId: "msg-empty" },
				{ type: "finish" },
			],
		},
	];

	for (const fixture of fixtures) {
		it(`processes "${fixture.name}" correctly`, () => {
			const actualChunks = processSessionUpdates(
				fixture.sessionUpdates,
				fixture.messageId,
			);

			assert.deepEqual(
				actualChunks,
				fixture.expectedChunks,
				`Chunks mismatch for fixture "${fixture.name}"`,
			);
		});
	}
});

describe("AI SDK integration", () => {
	it("produces valid UIMessage from text chunks", async () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-test" },
			{ type: "text-start", id: "text-msg-test-1" },
			{ type: "text-delta", id: "text-msg-test-1", delta: "Hello" },
			{ type: "text-delta", id: "text-msg-test-1", delta: " World" },
			{ type: "text-end", id: "text-msg-test-1" },
			{ type: "finish" },
		];

		const stream = chunksToStream(chunks);
		const initialMessage: UIMessage = {
			id: "msg-test",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		assert.ok(finalMessage, "Should produce a final message");
		assert.equal(finalMessage.id, "msg-test");
		assert.equal(finalMessage.role, "assistant");

		// Find text part
		const textPart = finalMessage.parts.find((p) => p.type === "text");
		assert.ok(textPart, "Should have text part");
		if (textPart?.type === "text") {
			assert.equal(textPart.text, "Hello World");
		}
	});

	it("produces valid UIMessage from reasoning chunks", async () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-reason" },
			{ type: "reasoning-start", id: "reasoning-msg-reason-1" },
			{
				type: "reasoning-delta",
				id: "reasoning-msg-reason-1",
				delta: "Think",
			},
			{
				type: "reasoning-delta",
				id: "reasoning-msg-reason-1",
				delta: "ing...",
			},
			{ type: "reasoning-end", id: "reasoning-msg-reason-1" },
			{ type: "finish" },
		];

		const stream = chunksToStream(chunks);
		const initialMessage: UIMessage = {
			id: "msg-reason",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		assert.ok(finalMessage, "Should produce a final message");

		// Find reasoning part
		const reasoningPart = finalMessage.parts.find(
			(p) => p.type === "reasoning",
		);
		assert.ok(reasoningPart, "Should have reasoning part");
		if (reasoningPart?.type === "reasoning") {
			assert.equal(reasoningPart.text, "Thinking...");
		}
	});

	it("produces valid UIMessage from tool chunks", async () => {
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-tool-test" },
			{
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				dynamic: true,
			},
			{
				type: "tool-input-available",
				toolCallId: "tc-1",
				toolName: "read_file",
				input: { path: "/test.txt" },
				dynamic: true,
			},
			{
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "file contents",
				dynamic: true,
			},
			{ type: "finish" },
		];

		const stream = chunksToStream(chunks);
		const initialMessage: UIMessage = {
			id: "msg-tool-test",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		assert.ok(finalMessage, "Should produce a final message");

		// Find tool part
		const toolPart = finalMessage.parts.find((p) => p.type === "dynamic-tool");
		assert.ok(toolPart, "Should have dynamic-tool part");
		if (toolPart?.type === "dynamic-tool") {
			assert.equal(toolPart.toolCallId, "tc-1");
			assert.equal(toolPart.toolName, "read_file");
			assert.equal(toolPart.state, "output-available");
			if (toolPart.state === "output-available") {
				assert.equal(toolPart.output, "file contents");
			}
		}
	});

	it("produces correct part order for text → tool → text", async () => {
		// This is the key regression test: parts should be in correct order
		const chunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-order" },
			{ type: "text-start", id: "text-1" },
			{ type: "text-delta", id: "text-1", delta: "Before tool. " },
			{ type: "text-end", id: "text-1" },
			{
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read",
				dynamic: true,
			},
			{
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "result",
				dynamic: true,
			},
			{ type: "text-start", id: "text-2" },
			{ type: "text-delta", id: "text-2", delta: "After tool." },
			{ type: "text-end", id: "text-2" },
			{ type: "finish" },
		];

		const stream = chunksToStream(chunks);
		const initialMessage: UIMessage = {
			id: "msg-order",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		assert.ok(finalMessage, "Should produce a final message");
		assert.equal(finalMessage.parts.length, 3, "Should have 3 parts");

		// Verify order: text, tool, text
		assert.equal(finalMessage.parts[0].type, "text");
		assert.equal(finalMessage.parts[1].type, "dynamic-tool");
		assert.equal(finalMessage.parts[2].type, "text");

		// Verify text content is separate
		if (finalMessage.parts[0].type === "text") {
			assert.equal(finalMessage.parts[0].text, "Before tool. ");
		}
		if (finalMessage.parts[2].type === "text") {
			assert.equal(finalMessage.parts[2].text, "After tool.");
		}
	});

	it("regression: missing start events loses text content", async () => {
		// This test documents the bug that was fixed:
		// Without proper text-start event, the SDK ignores text-delta events
		// and the final message has no text content
		const badChunks: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-bad" },
			// Missing: { type: "text-start", id: "..." }
			{ type: "text-delta", id: "text-1", delta: "Hello" },
			{ type: "text-delta", id: "text-1", delta: " World" },
			// Missing: { type: "text-end", id: "..." }
			{ type: "finish" },
		];

		const stream = chunksToStream(badChunks);
		const initialMessage: UIMessage = {
			id: "msg-bad",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		// Without text-start, the text deltas are ignored
		const textPart = finalMessage?.parts.find((p) => p.type === "text");

		// This demonstrates the bug: without proper start/end events,
		// text content is lost (textPart is undefined or empty)
		assert.ok(
			!textPart || (textPart.type === "text" && textPart.text === ""),
			"Without text-start, text should be lost or empty",
		);
	});

	it("handles full session update sequence via processSessionUpdates", async () => {
		const sessionUpdates: SessionUpdate[] = [
			{
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Analyzing request..." },
			},
			{
				sessionUpdate: "tool_call",
				toolCallId: "tc-search",
				title: "Search",
				status: "in_progress",
				rawInput: { query: "test" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-search",
				title: "Search",
				status: "completed",
				rawInput: { query: "test" },
				rawOutput: { results: ["a", "b"] },
			},
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Found 2 results." },
			},
		];

		const chunks = processSessionUpdates(sessionUpdates, "msg-full");
		const stream = chunksToStream(chunks);

		const initialMessage: UIMessage = {
			id: "msg-full",
			role: "assistant",
			parts: [],
		};

		const messageStream = readUIMessageStream({
			stream,
			message: initialMessage,
		});

		let finalMessage: UIMessage | undefined;
		for await (const message of messageStream) {
			finalMessage = message;
		}

		assert.ok(finalMessage, "Should produce a final message");

		// Verify all parts are present in correct order
		assert.equal(finalMessage.parts.length, 3, "Should have 3 parts");

		// Order: reasoning, tool, text
		assert.equal(finalMessage.parts[0].type, "reasoning");
		assert.equal(finalMessage.parts[1].type, "dynamic-tool");
		assert.equal(finalMessage.parts[2].type, "text");

		if (finalMessage.parts[0].type === "reasoning") {
			assert.equal(finalMessage.parts[0].text, "Analyzing request...");
		}
		if (finalMessage.parts[2].type === "text") {
			assert.equal(finalMessage.parts[2].text, "Found 2 results.");
		}
		if (finalMessage.parts[1].type === "dynamic-tool") {
			assert.equal(finalMessage.parts[1].state, "output-available");
		}
	});
});
