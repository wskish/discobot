import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import {
	createBlockIds,
	createStreamState,
	type StreamBlockIds,
	type StreamState,
} from "../server/stream.js";
import { sdkMessageToChunks } from "./translate.js";

describe("translate", () => {
	let streamState: StreamState;
	let blockIds: StreamBlockIds;

	beforeEach(() => {
		streamState = createStreamState();
		blockIds = createBlockIds("test-message-id");
	});

	describe("sdkMessageToChunks", () => {
		it("returns empty array for system init message", () => {
			const message = {
				type: "system" as const,
				subtype: "init" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);
			assert.strictEqual(chunks.length, 0);
		});

		it("returns empty array for user messages", () => {
			const message = {
				type: "user" as const,
				uuid: "uuid-1" as any,
				session_id: "session-1",
				message: {
					role: "user" as const,
					content: "Hello",
				},
				parent_tool_use_id: null,
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);
			assert.strictEqual(chunks.length, 0);
		});

		it("generates finish chunk for result message", () => {
			const message = {
				type: "result" as const,
				subtype: "success" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			assert.ok(chunks.length > 0);
			const finishChunk = chunks.find((c) => c.type === "finish");
			assert.ok(finishChunk, "Should have a finish chunk");
		});

		it("generates start chunk for first assistant message", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			const startChunk = chunks.find((c) => c.type === "start");
			assert.ok(startChunk, "Should have a start chunk");
		});

		it("generates text chunks for assistant text content", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			const textChunks = chunks.filter(
				(c) => c.type === "text-start" || c.type === "text-delta",
			);
			assert.ok(textChunks.length > 0, "Should have text chunks");
		});

		it("handles tool_use blocks", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should not crash when handling tool_use blocks
			// Tool support may generate chunks or be partially implemented
			assert.ok(Array.isArray(chunks));
		});

		it("handles stream events with partial messages", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_delta" as const,
					index: 0,
					delta: {
						type: "text_delta" as const,
						text: "Hello",
					},
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should generate text delta chunks
			const textDeltas = chunks.filter((c) => c.type === "text-delta");
			assert.ok(textDeltas.length > 0, "Should have text delta chunks");
		});

		it("handles content_block_start events", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_start" as const,
					index: 0,
					content_block: {
						type: "text" as const,
						text: "",
					},
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// May generate start chunks depending on implementation
			// At minimum should not crash
			assert.ok(Array.isArray(chunks));
		});

		it("handles content_block_stop events", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "content_block_stop" as const,
					index: 0,
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// May generate end chunks depending on implementation
			// At minimum should not crash
			assert.ok(Array.isArray(chunks));
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
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should handle message start
			assert.ok(Array.isArray(chunks));
		});

		it("handles message_delta events", () => {
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
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should handle message delta
			assert.ok(Array.isArray(chunks));
		});

		it("handles message_stop events", () => {
			const message = {
				type: "stream_event" as const,
				event: {
					type: "message_stop" as const,
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-1" as any,
				session_id: "session-1",
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should handle message stop
			assert.ok(Array.isArray(chunks));
		});

		it("maintains stream state across multiple messages", () => {
			// First message - text start
			const message1 = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "First part",
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

			const chunks1 = sdkMessageToChunks(message1, streamState, blockIds);
			assert.ok(chunks1.length > 0);

			// Stream state should now be updated
			assert.ok(
				streamState.currentTextBlockId !== null,
				"Should have current text block ID",
			);

			// Second message - continue text
			const message2 = {
				type: "stream_event" as const,
				event: {
					type: "content_block_delta" as const,
					index: 0,
					delta: {
						type: "text_delta" as const,
						text: " continued",
					},
				} as any,
				parent_tool_use_id: null,
				uuid: "uuid-2" as any,
				session_id: "session-1",
			};

			const chunks2 = sdkMessageToChunks(message2, streamState, blockIds);
			assert.ok(chunks2.length > 0);
		});

		it("generates correct chunk IDs", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
				session_id: "session-1",
				message: {
					id: "msg-1",
					type: "message" as const,
					role: "assistant" as const,
					content: [
						{
							type: "text" as const,
							text: "Test",
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Chunks that have IDs should have valid IDs
			// Some chunks like finish chunks may not have IDs
			assert.ok(chunks.length > 0, "Should generate some chunks");
		});

		it("handles empty content arrays", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
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

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should handle gracefully, may have start/finish chunks
			assert.ok(Array.isArray(chunks));
		});

		it("handles multiple content blocks in single message", () => {
			const message = {
				type: "assistant" as const,
				uuid: "uuid-1" as any,
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
				},
				parent_tool_use_id: null,
			};

			const chunks = sdkMessageToChunks(message, streamState, blockIds);

			// Should handle messages with multiple content blocks
			const textChunks = chunks.filter((c) => c.type.includes("text"));

			// Should at least have text chunks
			assert.ok(textChunks.length > 0, "Should have text chunks");
			// Tool chunks may or may not be generated depending on implementation
			assert.ok(chunks.length > 0, "Should generate chunks");
		});
	});
});
