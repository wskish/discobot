import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type {
	SDKAssistantMessage,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	createTranslationState,
	generateBlockId,
	type TranslationState,
	translateAssistantMessage,
	translateSDKMessage,
} from "./translate.js";

// Helpers to cast test fixtures to SDK types (bypasses strict type checks for test data)
function asAssistantMessage(msg: unknown): SDKAssistantMessage {
	return msg as SDKAssistantMessage;
}

function asSDKMessage(msg: unknown): SDKMessage {
	return msg as SDKMessage;
}

describe("translate", () => {
	let translationState: TranslationState;

	beforeEach(() => {
		translationState = createTranslationState("test-message-uuid");
	});

	describe("generateBlockId", () => {
		it("generates deterministic text block IDs", () => {
			const id = generateBlockId("uuid-123", 0, "text");
			assert.strictEqual(id, "text-uuid-123-0");
		});

		it("generates deterministic reasoning block IDs", () => {
			const id = generateBlockId("uuid-456", 2, "reasoning");
			assert.strictEqual(id, "reasoning-uuid-456-2");
		});
	});

	describe("translateSDKMessage", () => {
		it("returns empty array for system init message", () => {
			const message = {
				type: "system" as const,
				subtype: "init" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				apiKeySource: "user" as const,
				cwd: "/test",
				tools: ["Read"],
				mcp_servers: [],
				model: "claude-sonnet-4-5-20250929",
				permissionMode: "bypassPermissions" as const,
				slash_commands: [],
				output_style: "default",
				claude_code_version: "1.0.0",
				skills: [],
				plugins: [],
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);
			assert.strictEqual(chunks.length, 0);
		});

		it("returns empty array for user messages", () => {
			const message = {
				type: "user" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					role: "user" as const,
					content: "Hello",
				},
				parent_tool_use_id: null,
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);
			assert.strictEqual(chunks.length, 0);
		});

		it("result message closes orphaned blocks and emits finish", () => {
			// Set up orphaned open blocks (simulating a case where content_block_stop didn't fire)
			translationState.openTextIndices.add(0);
			translationState.openReasoningIndices.add(1);

			const message = {
				type: "result" as const,
				subtype: "success" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				duration_ms: 1000,
				duration_api_ms: 800,
				is_error: false,
				num_turns: 3,
				result: "Task completed",
				total_cost_usd: 0.05,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
				modelUsage: {},
				permission_denials: [],
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			// Should close orphaned blocks
			const textEnd = chunks.find((c) => c.type === "text-end");
			const reasoningEnd = chunks.find((c) => c.type === "reasoning-end");
			assert.ok(textEnd, "Should close orphaned text block");
			assert.ok(reasoningEnd, "Should close orphaned reasoning block");

			// Should always emit finish on result (end of entire response)
			const finishChunk = chunks.find((c) => c.type === "finish");
			assert.ok(finishChunk, "Should emit finish on result");
		});

		it("returns empty array for assistant message (use translateAssistantMessage for complete messages)", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "Hello!",
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
				},
				parent_tool_use_id: null,
			};

			// translateSDKMessage returns [] for assistant messages during streaming
			// to avoid duplicating content from stream_events
			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);
			assert.strictEqual(chunks.length, 0);
		});

		it("generates start and finish chunks for assistant message", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "Hello!",
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
				},
				parent_tool_use_id: null,
			};

			// Use translateAssistantMessage directly for complete message translation
			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const startChunk = chunks.find((c) => c.type === "start");
			assert.ok(startChunk, "Should have a start chunk");
			const finishChunk = chunks.find((c) => c.type === "finish");
			assert.ok(finishChunk, "Should have a finish chunk");
		});

		it("generates text chunks for assistant text content", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "This is a response.",
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 20,
					},
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const textStart = chunks.filter((c) => c.type === "text-start");
			const textDelta = chunks.filter((c) => c.type === "text-delta");
			const textEnd = chunks.filter((c) => c.type === "text-end");

			assert.strictEqual(textStart.length, 1, "Should have one text-start");
			assert.strictEqual(textDelta.length, 1, "Should have one text-delta");
			assert.strictEqual(textEnd.length, 1, "Should have one text-end");

			// Check ID consistency - uses message.id not uuid
			assert.strictEqual(
				(textStart[0] as { id: string }).id,
				"text-msg-1-0",
				"Text block ID should use message.id and index",
			);
		});

		it("handles tool_use blocks", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "tool_use" as const,
							id: "tool-1",
							name: "Read",
							input: {
								file_path: "/test.txt",
							},
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "tool_use" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const toolStart = chunks.find((c) => c.type === "tool-input-start");
			const toolAvailable = chunks.find(
				(c) => c.type === "tool-input-available",
			);

			assert.ok(toolStart, "Should have tool-input-start");
			assert.ok(toolAvailable, "Should have tool-input-available");
			assert.strictEqual(
				(toolStart as { toolCallId: string }).toolCallId,
				"tool-1",
			);
		});

		it("handles stream events with partial messages", () => {
			// First emit message_start to initialize state
			const startMessage = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-1",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(startMessage), translationState);

			// Then emit content_block_start
			const blockStartMessage = {
				type: "stream_event" as const,
				event: {
					type: "content_block_start" as const,
					index: 0,
					content_block: {
						type: "text" as const,
						text: "",
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(blockStartMessage), translationState);

			// Now emit delta
			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_delta" as const,
					index: 0,
					delta: {
						type: "text_delta" as const,
						text: "Hello",
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			const textDeltas = chunks.filter((c) => c.type === "text-delta");
			assert.ok(textDeltas.length > 0, "Should have text delta chunks");
		});

		it("handles content_block_start events", () => {
			// Initialize with message_start
			const startMessage = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-1",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(startMessage), translationState);

			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_start" as const,
					index: 0,
					content_block: {
						type: "text" as const,
						text: "",
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			const textStart = chunks.find((c) => c.type === "text-start");
			assert.ok(textStart, "Should have text-start");
			assert.strictEqual(
				(textStart as { id: string }).id,
				"text-msg-1-0",
				"Should use message.id from translation state",
			);
		});

		it("handles content_block_stop events", () => {
			// Set up state with an open text block
			translationState.openTextIndices.add(0);

			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_stop" as const,
					index: 0,
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			const textEnd = chunks.find((c) => c.type === "text-end");
			assert.ok(textEnd, "Should have text-end");
			assert.strictEqual(
				translationState.openTextIndices.size,
				0,
				"Should close block",
			);
		});

		it("handles message_start events", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-1",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 10,
							output_tokens: 0,
						},
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "new-uuid" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			const startChunk = chunks.find((c) => c.type === "start");
			assert.ok(startChunk, "Should emit start chunk");
			assert.strictEqual(
				translationState.messageUuid,
				"msg-1",
				"Should update translation state with message.id",
			);
		});

		it("message_start emits start-step for subsequent API calls in agentic loop", () => {
			// Simulate that first message already started
			translationState.hasEmittedStart = true;
			translationState.responseMessageId = "msg-1";
			translationState.messageUuid = "msg-1";

			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-2",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "new-uuid" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			// Should emit start-step for subsequent API call (not start)
			assert.strictEqual(chunks.length, 1, "Should emit one chunk");
			assert.strictEqual(
				chunks[0].type,
				"start-step",
				"Should emit start-step for subsequent API call",
			);
			assert.strictEqual(
				translationState.messageUuid,
				"msg-2",
				"Should update to new message id",
			);
			assert.strictEqual(
				translationState.responseMessageId,
				"msg-1",
				"Should keep original response message id",
			);
		});

		it("message_start emits deferred finish-step before start-step", () => {
			// Simulate previous step ended (needsFinishStep=true)
			translationState.hasEmittedStart = true;
			translationState.responseMessageId = "msg-1";
			translationState.messageUuid = "msg-1";
			translationState.needsFinishStep = true;

			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-2",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "new-uuid" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);

			// Should emit finish-step THEN start-step
			assert.strictEqual(chunks.length, 2, "Should emit two chunks");
			assert.strictEqual(
				chunks[0].type,
				"finish-step",
				"First chunk should be deferred finish-step",
			);
			assert.strictEqual(
				chunks[1].type,
				"start-step",
				"Second chunk should be start-step",
			);
			assert.strictEqual(
				translationState.needsFinishStep,
				false,
				"Should clear needsFinishStep flag",
			);
		});

		it("handles message_delta events (no chunks)", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_delta" as const,
					delta: {
						stop_reason: "end_turn" as const,
						stop_sequence: null,
					},
					usage: {
						output_tokens: 50,
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};

			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);
			assert.strictEqual(
				chunks.length,
				0,
				"message_delta should not produce chunks",
			);
		});

		it("handles message_stop events (defers finish-step)", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_stop" as const,
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};

			// message_stop defers finish-step to ensure tool outputs come first
			const chunks = translateSDKMessage(
				asSDKMessage(message),
				translationState,
			);
			assert.strictEqual(
				chunks.length,
				0,
				"message_stop should not produce chunks immediately",
			);
			assert.strictEqual(
				translationState.needsFinishStep,
				true,
				"Should set needsFinishStep flag",
			);
		});

		it("tracks open blocks correctly", () => {
			// Start message
			const startMessage = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-1",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(startMessage), translationState);

			// Block start
			const blockStart = {
				type: "stream_event" as const,
				event: {
					type: "content_block_start" as const,
					index: 0,
					content_block: { type: "text" as const, text: "" },
				} as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(blockStart), translationState);

			assert.ok(
				translationState.openTextIndices.has(0),
				"Should track open text block",
			);

			// Block stop
			const blockStop = {
				type: "stream_event" as const,
				event: { type: "content_block_stop" as const, index: 0 } as unknown,
				parent_tool_use_id: null,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(blockStop), translationState);

			assert.strictEqual(
				translationState.openTextIndices.size,
				0,
				"Should close text block on stop",
			);
		});

		it("generates correct chunk IDs using uuid and index", () => {
			const message = {
				type: "assistant" as const,
				uuid: "my-uuid-123" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{ type: "text" as const, text: "First" },
						{ type: "text" as const, text: "Second" },
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 5 },
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			// First text block should have index 0 (uses message.id, not uuid)
			const firstTextStart = chunks.find(
				(c) =>
					c.type === "text-start" &&
					(c as { id: string }).id === "text-msg-1-0",
			);
			assert.ok(firstTextStart, "First text block should have index 0");

			// Second text block should have index 1
			const secondTextStart = chunks.find(
				(c) =>
					c.type === "text-start" &&
					(c as { id: string }).id === "text-msg-1-1",
			);
			assert.ok(secondTextStart, "Second text block should have index 1");
		});

		it("handles empty content arrays", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "end_turn" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 0,
					},
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			// Should have start and finish, nothing else
			assert.strictEqual(chunks.length, 2);
			assert.strictEqual(chunks[0].type, "start");
			assert.strictEqual(chunks[1].type, "finish");
		});

		it("handles multiple content blocks in single message", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "Text before tool",
						},
						{
							type: "tool_use" as const,
							id: "tool-1",
							name: "Read",
							input: { file_path: "/test.txt" },
						},
						{
							type: "text" as const,
							text: "Text after tool",
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "end_turn" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 20,
					},
					container: null,
					context_management: null,
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			// Should have text, tool, and text blocks
			const textStarts = chunks.filter((c) => c.type === "text-start");
			const toolStarts = chunks.filter((c) => c.type === "tool-input-start");

			assert.strictEqual(textStarts.length, 2, "Should have two text blocks");
			assert.strictEqual(toolStarts.length, 1, "Should have one tool block");
		});

		it("handles thinking/reasoning blocks", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "thinking" as const,
							thinking: "Let me think about this...",
						},
						{
							type: "text" as const,
							text: "Here is my answer.",
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "end_turn" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 20,
					},
					container: null,
					context_management: null,
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const reasoningStart = chunks.find((c) => c.type === "reasoning-start");
			const reasoningDelta = chunks.find((c) => c.type === "reasoning-delta");
			const reasoningEnd = chunks.find((c) => c.type === "reasoning-end");

			assert.ok(reasoningStart, "Should have reasoning-start");
			assert.ok(reasoningDelta, "Should have reasoning-delta");
			assert.ok(reasoningEnd, "Should have reasoning-end");
			assert.strictEqual(
				(reasoningStart as { id: string }).id,
				"reasoning-msg-1-0",
				"Reasoning block should have correct ID (uses message.id)",
			);
		});

		it("handles tool_result blocks", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "tool-123",
							content: "file contents here",
							is_error: false,
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "end_turn" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
					container: null,
					context_management: null,
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const toolOutput = chunks.find((c) => c.type === "tool-output-available");
			assert.ok(toolOutput, "Should have tool-output-available");
			assert.strictEqual(
				(toolOutput as { toolCallId: string }).toolCallId,
				"tool-123",
			);
		});

		it("handles tool_result errors", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as unknown,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "tool_result" as const,
							tool_use_id: "tool-123",
							content: "Error: file not found",
							is_error: true,
						},
					],
					model: "claude-sonnet-4-5-20250929",
					stop_reason: "end_turn" as const,
					stop_sequence: null,
					usage: {
						input_tokens: 10,
						output_tokens: 5,
					},
					container: null,
					context_management: null,
				},
				parent_tool_use_id: null,
			};

			const chunks = translateAssistantMessage(asAssistantMessage(message));

			const toolError = chunks.find((c) => c.type === "tool-output-error");
			assert.ok(toolError, "Should have tool-output-error");
			assert.strictEqual(
				(toolError as { errorText: string }).errorText,
				"Error: file not found",
			);
		});

		it("handles streaming tool input deltas", () => {
			// Initialize state
			const startMessage = {
				type: "stream_event" as const,
				event: {
					type: "message_start" as const,
					message: {
						id: "msg-1",
						type: "message" as const,
						role: "assistant" as const,
						content: [],
						model: "claude-sonnet-4-5-20250929",
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
				parent_tool_use_id: null,
				uuid: "uuid-1",
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(startMessage), translationState);

			// Tool use start
			const toolStart = {
				type: "stream_event" as const,
				event: {
					type: "content_block_start" as const,
					index: 0,
					content_block: {
						type: "tool_use" as const,
						id: "tool-1",
						name: "Bash",
						input: {},
					},
				},
				parent_tool_use_id: null,
				uuid: "uuid-1",
				session_id: "session-1",
			};
			translateSDKMessage(asSDKMessage(toolStart), translationState);

			// Input JSON delta
			const inputDelta = {
				type: "stream_event" as const,
				event: {
					type: "content_block_delta" as const,
					index: 0,
					delta: {
						type: "input_json_delta" as const,
						partial_json: '{"command":',
					},
				},
				parent_tool_use_id: null,
				uuid: "uuid-1",
				session_id: "session-1",
			};
			const chunks = translateSDKMessage(
				asSDKMessage(inputDelta),
				translationState,
			);

			const toolInputDelta = chunks.find((c) => c.type === "tool-input-delta");
			assert.ok(toolInputDelta, "Should have tool-input-delta");
			assert.strictEqual(
				(toolInputDelta as { toolCallId: string }).toolCallId,
				"tool-1",
			);
		});
	});
});
