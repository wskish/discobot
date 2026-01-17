import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	SessionUpdate,
	ToolCall,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import { readUIMessageStream } from "ai";
import {
	createBlockIds,
	createErrorChunk,
	createFinishChunks,
	createReasoningChunks,
	createStartChunk,
	createStreamState,
	createTextChunks,
	createToolCallChunks,
	createToolCallUpdateChunks,
	sessionUpdateToChunks,
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
		chunks.push(...sessionUpdateToChunks(update, state, ids));
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
			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "test",
				status: "in_progress",
				rawInput: {},
			};
			createToolCallChunks(toolCall, state);
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
					const toolCall: ToolCall = {
						toolCallId: `tc-${i}`,
						title: "test",
						status: "completed",
						rawInput: {},
						rawOutput: "done",
					};
					createToolCallChunks(toolCall, state);
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

	describe("createToolCallChunks", () => {
		it("closes open text block before tool and emits tool-input-start", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// Start text
			createTextChunks("Let me check", state, ids);

			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "pending",
			};

			const chunks = createToolCallChunks(toolCall, state);

			// Should close text, then emit tool-input-start
			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], { type: "text-end", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				title: "read_file",
				providerMetadata: undefined,
				dynamic: true,
			});
			assert.equal(state.currentTextBlockId, null);
		});

		it("emits tool-input-start on first encounter (no prior blocks)", () => {
			const state = createStreamState();
			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "pending",
			};

			const chunks = createToolCallChunks(toolCall, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				title: "read_file",
				providerMetadata: undefined,
				dynamic: true,
			});
		});

		it("emits tool-input-available on in_progress status", () => {
			const state = createStreamState();

			// First: pending (input-streaming)
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "pending",
			};
			createToolCallChunks(toolCall1, state);

			// Second: in_progress (input-available)
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			const chunks = createToolCallChunks(toolCall2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-input-available",
				toolCallId: "tc-1",
				toolName: "read_file",
				title: "read_file",
				input: { path: "/test.txt" },
				providerMetadata: undefined,
				dynamic: true,
			});
		});

		it("emits tool-output-available on completed status", () => {
			const state = createStreamState();

			// Setup: in_progress
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			createToolCallChunks(toolCall1, state);

			// Complete: completed
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "completed",
				rawInput: { path: "/test.txt" },
				rawOutput: "file contents",
			};
			const chunks = createToolCallChunks(toolCall2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "file contents",
				dynamic: true,
			});
		});

		it("emits tool-output-error on failed status", () => {
			const state = createStreamState();

			// Setup: in_progress
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			createToolCallChunks(toolCall1, state);

			// Fail: failed
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "failed",
				rawInput: { path: "/test.txt" },
				rawOutput: "File not found",
			};
			const chunks = createToolCallChunks(toolCall2, state);

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

			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};

			// First call: should emit start + input-available
			const chunks1 = createToolCallChunks(toolCall, state);
			assert.equal(chunks1.length, 2);

			// Second call with same state: should emit nothing
			const chunks2 = createToolCallChunks(toolCall, state);
			assert.equal(chunks2.length, 0);
		});

		it("emits tool-input-available as fallback when going directly from pending to completed", () => {
			const state = createStreamState();

			// First: pending (simulating Claude Code which skips in_progress)
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Bash",
				status: "pending",
				rawInput: { command: "ls" },
			};
			createToolCallChunks(toolCall1, state);

			// Directly to completed (skipping in_progress)
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "Bash",
				status: "completed",
				rawInput: { command: "ls" },
				rawOutput: "file1.txt\nfile2.txt",
			};
			const chunks = createToolCallChunks(toolCall2, state);

			// Should emit: input-available (fallback) + output-available
			assert.equal(chunks.length, 2);
			assert.equal(chunks[0].type, "tool-input-available");
			assert.equal(chunks[1].type, "tool-output-available");

			if (chunks[0].type === "tool-input-available") {
				assert.deepEqual(chunks[0].input, { command: "ls" });
			}
			if (chunks[1].type === "tool-output-available") {
				assert.equal(chunks[1].output, "file1.txt\nfile2.txt");
			}
		});

		it("emits tool-input-available as fallback when going directly from pending to failed", () => {
			const state = createStreamState();

			// First: pending
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Write",
				status: "pending",
				rawInput: { path: "/readonly.txt" },
			};
			createToolCallChunks(toolCall1, state);

			// Directly to failed
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "Write",
				status: "failed",
				rawInput: { path: "/readonly.txt" },
				rawOutput: "Permission denied",
			};
			const chunks = createToolCallChunks(toolCall2, state);

			// Should emit: input-available (fallback) + output-error
			assert.equal(chunks.length, 2);
			assert.equal(chunks[0].type, "tool-input-available");
			assert.equal(chunks[1].type, "tool-output-error");
		});

		it("does not emit duplicate input-available when already sent via in_progress", () => {
			const state = createStreamState();

			// First: in_progress (sends input-available)
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Read",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			const chunks1 = createToolCallChunks(toolCall1, state);
			assert.equal(chunks1.length, 2); // start + input-available

			// Then: completed
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "Read",
				status: "completed",
				rawInput: { path: "/test.txt" },
				rawOutput: "contents",
			};
			const chunks2 = createToolCallChunks(toolCall2, state);

			// Should only emit output-available (no duplicate input-available)
			assert.equal(chunks2.length, 1);
			assert.equal(chunks2[0].type, "tool-output-available");
		});

		it("preserves last known rawInput across multiple pending updates", () => {
			const state = createStreamState();

			// First: pending with empty input
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Bash",
				status: "pending",
				rawInput: {},
			};
			createToolCallChunks(toolCall1, state);

			// Second: pending with populated input
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "`ls -la`",
				status: "pending",
				rawInput: { command: "ls -la" },
			};
			createToolCallChunks(toolCall2, state);

			// Third: completed without rawInput - should use last known
			const toolCall3: ToolCall = {
				toolCallId: "tc-1",
				title: "`ls -la`",
				status: "completed",
				rawOutput: "file1.txt",
			};
			const chunks = createToolCallChunks(toolCall3, state);

			// Should emit input-available with the last known input
			assert.equal(chunks.length, 2);
			assert.equal(chunks[0].type, "tool-input-available");
			if (chunks[0].type === "tool-input-available") {
				assert.deepEqual(chunks[0].input, { command: "ls -la" });
			}
		});
	});

	describe("createToolCallUpdateChunks", () => {
		it("emits tool-input-start on first encounter", () => {
			const state = createStreamState();
			const update: ToolCallUpdate = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "pending",
			};

			const chunks = createToolCallUpdateChunks(update, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "read_file",
				title: "read_file",
				providerMetadata: undefined,
				dynamic: true,
			});
		});

		it("uses 'unknown' for missing title", () => {
			const state = createStreamState();
			const update: ToolCallUpdate = {
				toolCallId: "tc-1",
				status: "pending",
			};

			const chunks = createToolCallUpdateChunks(update, state);

			assert.equal(chunks.length, 1);
			const startChunk = chunks[0];
			assert.equal(startChunk.type, "tool-input-start");
			if (startChunk.type === "tool-input-start") {
				assert.equal(startChunk.toolName, "unknown");
			}
		});

		it("emits tool-output-available on completed status", () => {
			const state = createStreamState();

			// Setup: in_progress
			const update1: ToolCallUpdate = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			createToolCallUpdateChunks(update1, state);

			// Complete
			const update2: ToolCallUpdate = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "completed",
				rawInput: { path: "/test.txt" },
				rawOutput: "file contents",
			};
			const chunks = createToolCallUpdateChunks(update2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "file contents",
				dynamic: true,
			});
		});

		it("emits tool-output-error on failed status", () => {
			const state = createStreamState();

			// Setup: in_progress
			const update1: ToolCallUpdate = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			createToolCallUpdateChunks(update1, state);

			// Fail
			const update2: ToolCallUpdate = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "failed",
				rawInput: { path: "/test.txt" },
				rawOutput: "File not found",
			};
			const chunks = createToolCallUpdateChunks(update2, state);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-error",
				toolCallId: "tc-1",
				errorText: "File not found",
				dynamic: true,
			});
		});
	});

	describe("Claude Code _meta extraction", () => {
		it("extracts toolName from _meta.claudeCode.toolName", () => {
			const state = createStreamState();
			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "`ls -la /tmp`", // Display title
				status: "pending",
				_meta: {
					claudeCode: {
						toolName: "Bash", // Actual tool name
					},
				},
			};

			const chunks = createToolCallChunks(toolCall, state);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0];
			assert.equal(chunk.type, "tool-input-start");
			if (chunk.type === "tool-input-start") {
				assert.equal(chunk.toolName, "Bash"); // Should use _meta.claudeCode.toolName
				assert.equal(chunk.title, "`ls -la /tmp`"); // Should preserve display title
				// NOTE: providerMetadata is not currently supported by AI SDK's Zod schema
			}
		});

		it("extracts output from _meta.claudeCode.toolResponse", () => {
			const state = createStreamState();

			// First: setup tool in progress
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Terminal",
				status: "in_progress",
				rawInput: { command: "ls" },
				_meta: { claudeCode: { toolName: "Bash" } },
			};
			createToolCallChunks(toolCall1, state);

			// Complete with toolResponse in _meta
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "Terminal",
				status: "completed",
				rawInput: { command: "ls" },
				// rawOutput is NOT set - output should come from _meta
				_meta: {
					claudeCode: {
						toolName: "Bash",
						toolResponse: {
							stdout: "file1.txt\nfile2.txt",
							stderr: "",
							interrupted: false,
						},
					},
				},
			};
			const chunks = createToolCallChunks(toolCall2, state);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0];
			assert.equal(chunk.type, "tool-output-available");
			if (chunk.type === "tool-output-available") {
				assert.deepEqual(chunk.output, {
					stdout: "file1.txt\nfile2.txt",
					stderr: "",
					interrupted: false,
				});
			}
		});

		it("prefers rawOutput over _meta.claudeCode.toolResponse", () => {
			const state = createStreamState();

			// Setup tool
			const toolCall1: ToolCall = {
				toolCallId: "tc-1",
				title: "Read",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			createToolCallChunks(toolCall1, state);

			// Complete with both rawOutput and _meta.toolResponse
			const toolCall2: ToolCall = {
				toolCallId: "tc-1",
				title: "Read",
				status: "completed",
				rawInput: { path: "/test.txt" },
				rawOutput: "standard output", // Should take precedence
				_meta: {
					claudeCode: {
						toolName: "Read",
						toolResponse: {
							stdout: "should not use this",
							stderr: "",
						},
					},
				},
			};
			const chunks = createToolCallChunks(toolCall2, state);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0];
			assert.equal(chunk.type, "tool-output-available");
			if (chunk.type === "tool-output-available") {
				assert.equal(chunk.output, "standard output");
			}
		});

		it("falls back to title when _meta.claudeCode.toolName not present", () => {
			const state = createStreamState();
			const toolCall: ToolCall = {
				toolCallId: "tc-1",
				title: "read_file",
				status: "pending",
				// No _meta
			};

			const chunks = createToolCallChunks(toolCall, state);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0];
			assert.equal(chunk.type, "tool-input-start");
			if (chunk.type === "tool-input-start") {
				assert.equal(chunk.toolName, "read_file"); // Falls back to title
			}
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

	describe("sessionUpdateToChunks", () => {
		it("handles agent_message_chunk with text", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const update: SessionUpdate = {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Hello" },
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], { type: "text-start", id: "text-msg-1-1" });
			assert.deepEqual(chunks[1], {
				type: "text-delta",
				id: "text-msg-1-1",
				delta: "Hello",
			});
		});

		it("handles agent_thought_chunk with text", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const update: SessionUpdate = {
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Thinking..." },
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

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
		});

		it("handles tool_call", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const update: SessionUpdate = {
				sessionUpdate: "tool_call",
				toolCallId: "tc-1",
				title: "Read",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0], {
				type: "tool-input-start",
				toolCallId: "tc-1",
				toolName: "Read",
				title: "Read",
				providerMetadata: undefined,
				dynamic: true,
			});
			assert.deepEqual(chunks[1], {
				type: "tool-input-available",
				toolCallId: "tc-1",
				toolName: "Read",
				title: "Read",
				input: { path: "/test.txt" },
				providerMetadata: undefined,
				dynamic: true,
			});
		});

		it("handles tool_call_update", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");

			// First: tool_call
			const toolCall: SessionUpdate = {
				sessionUpdate: "tool_call",
				toolCallId: "tc-1",
				title: "Read",
				status: "in_progress",
				rawInput: { path: "/test.txt" },
			};
			sessionUpdateToChunks(toolCall, state, ids);

			// Then: tool_call_update
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-1",
				title: "Read",
				status: "completed",
				rawInput: { path: "/test.txt" },
				rawOutput: "file contents",
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

			assert.equal(chunks.length, 1);
			assert.deepEqual(chunks[0], {
				type: "tool-output-available",
				toolCallId: "tc-1",
				output: "file contents",
				dynamic: true,
			});
		});

		it("returns empty array for non-text content", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const update: SessionUpdate = {
				sessionUpdate: "agent_message_chunk",
				content: { type: "image", data: "base64data", mimeType: "image/png" },
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

			assert.equal(chunks.length, 0);
		});

		it("returns empty array for unhandled update types", () => {
			const state = createStreamState();
			const ids = createBlockIds("msg-1");
			const update: SessionUpdate = {
				sessionUpdate: "plan",
				entries: [],
			};

			const chunks = sessionUpdateToChunks(update, state, ids);

			assert.equal(chunks.length, 0);
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
					title: "Read",
					providerMetadata: undefined,
					dynamic: true,
				},
				{
					type: "tool-input-available",
					toolCallId: "tc-read",
					toolName: "Read",
					title: "Read",
					input: { path: "/file.txt" },
					providerMetadata: undefined,
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
					title: "Write",
					providerMetadata: undefined,
					dynamic: true,
				},
				{
					type: "tool-input-available",
					toolCallId: "tc-fail",
					toolName: "Write",
					title: "Write",
					input: { path: "/readonly.txt" },
					providerMetadata: undefined,
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
		{
			name: "Claude Code flow: text → tool (pending → completed) → text",
			messageId: "msg-claude-code",
			sessionUpdates: [
				// Text before tool
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "I'll list the files." },
				},
				// Tool call with pending status and empty input
				{
					sessionUpdate: "tool_call",
					toolCallId: "tc-bash",
					title: "Terminal",
					status: "pending",
					rawInput: {},
					_meta: { claudeCode: { toolName: "Bash" } },
				},
				// Tool call with pending status and populated input
				{
					sessionUpdate: "tool_call",
					toolCallId: "tc-bash",
					title: "`ls -la /tmp`",
					status: "pending",
					rawInput: { command: "ls -la /tmp", description: "List files" },
					_meta: { claudeCode: { toolName: "Bash" } },
				},
				// Tool call update with toolResponse in _meta (skipping in_progress)
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "tc-bash",
					_meta: {
						claudeCode: {
							toolName: "Bash",
							toolResponse: {
								stdout: "file1.txt\nfile2.txt",
								stderr: "",
								interrupted: false,
							},
						},
					},
				},
				// Tool call update with completed status
				{
					sessionUpdate: "tool_call_update",
					toolCallId: "tc-bash",
					title: "`ls -la /tmp`",
					status: "completed",
					content: [
						{
							type: "content",
							content: { type: "text", text: "file1.txt\nfile2.txt" },
						},
					],
					_meta: { claudeCode: { toolName: "Bash" } },
				},
				// Text after tool
				{
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Found 2 files." },
				},
			],
			expectedChunks: [
				{ type: "start", messageId: "msg-claude-code" },
				// First text block
				{ type: "text-start", id: "text-msg-claude-code-1" },
				{
					type: "text-delta",
					id: "text-msg-claude-code-1",
					delta: "I'll list the files.",
				},
				{ type: "text-end", id: "text-msg-claude-code-1" },
				// Tool start
				{
					type: "tool-input-start",
					toolCallId: "tc-bash",
					toolName: "Bash",
					title: "Terminal",
					providerMetadata: { claudeCode: { toolName: "Bash" } },
					dynamic: true,
				},
				// Input available (fallback before output since in_progress was skipped)
				{
					type: "tool-input-available",
					toolCallId: "tc-bash",
					toolName: "Bash",
					title: "`ls -la /tmp`",
					input: { command: "ls -la /tmp", description: "List files" },
					providerMetadata: { claudeCode: { toolName: "Bash" } },
					dynamic: true,
				},
				// Output available
				{
					type: "tool-output-available",
					toolCallId: "tc-bash",
					output: "file1.txt\nfile2.txt",
					dynamic: true,
				},
				// Second text block (different ID)
				{ type: "text-start", id: "text-msg-claude-code-2" },
				{
					type: "text-delta",
					id: "text-msg-claude-code-2",
					delta: "Found 2 files.",
				},
				{ type: "text-end", id: "text-msg-claude-code-2" },
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
				providerMetadata: undefined,
				dynamic: true,
			},
			{
				type: "tool-input-available",
				toolCallId: "tc-1",
				toolName: "read_file",
				input: { path: "/test.txt" },
				providerMetadata: undefined,
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
				providerMetadata: undefined,
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
