import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UIMessageChunk } from "ai";
import type { StreamBlockIds, StreamState } from "../server/stream.js";
import {
	createFinishChunks,
	createReasoningChunks,
	createStartChunk,
	createTextChunks,
} from "../server/stream.js";

// Type for streaming events from the SDK
// Using a loose type since the SDK doesn't export these event types
interface StreamEvent {
	type?: string;
	index?: number;
	content_block?: {
		type?: string;
		id?: string;
		name?: string;
		input?: unknown;
		text?: string;
		thinking?: string;
	};
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		partial_json?: string;
	};
}

// Type for thinking content blocks
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

// Type for tool result blocks
interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	is_error?: boolean;
	content: string;
}

export function sdkMessageToChunks(
	msg: SDKMessage,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Debug logging for tool-related events
	if (msg.type === "stream_event") {
		const event = (msg as { event: StreamEvent }).event;
		if (
			event.type === "content_block_start" ||
			event.type === "content_block_delta" ||
			event.type === "content_block_stop"
		) {
			console.log(
				`[SDK] stream_event: ${event.type}`,
				JSON.stringify(event, null, 2).substring(0, 500),
			);
		}
	}

	switch (msg.type) {
		case "assistant":
			chunks.push(...translateAssistantMessage(msg, state, ids));
			break;

		case "result":
			chunks.push(...createFinishChunks(state, ids));
			break;

		case "stream_event":
			// Handle partial streaming events
			chunks.push(...translateStreamEvent(msg, state, ids));
			break;

		case "system":
		case "user":
			// No chunks for these
			break;
	}

	return chunks;
}

function translateAssistantMessage(
	msg: SDKAssistantMessage,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// If this is the first message part, emit start chunk
	if (!state.currentTextBlockId && !state.currentReasoningBlockId) {
		chunks.push(createStartChunk(ids.messageId));
	}

	// Process content blocks from the API message
	const content = msg.message.content;
	for (const block of content) {
		if (block.type === "text") {
			chunks.push(...createTextChunks(block.text, state, ids));
		} else if (block.type === "thinking") {
			// Extended thinking/reasoning block
			const thinkingBlock = block as ThinkingBlock;
			chunks.push(...createReasoningChunks(thinkingBlock.thinking, state, ids));
		} else if (block.type === "tool_use") {
			// Tool calls will be handled in streaming events
			// This block appears in final assistant messages after tool execution
		} else if (block.type === "tool_result") {
			// Tool result - emit output-available chunk
			const toolResult = block as ToolResultBlock;
			const toolCallId = toolResult.tool_use_id;

			console.log(
				`[SDK] Translating tool result for ${toolCallId}`,
				toolResult.is_error ? "(ERROR)" : "(SUCCESS)",
			);

			if (toolResult.is_error) {
				chunks.push({
					type: "tool-output-error",
					toolCallId,
					errorText: toolResult.content,
					dynamic: true,
				});
			} else {
				chunks.push({
					type: "tool-output-available",
					toolCallId,
					output: toolResult.content,
					dynamic: true,
				});
			}

			// Update tool state
			const toolState = state.toolStates.get(toolCallId);
			if (toolState) {
				toolState.state = toolResult.is_error
					? "output-error"
					: "output-available";
			}
		}
	}

	return chunks;
}

function translateStreamEvent(
	msg: SDKPartialAssistantMessage,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	// Handle streaming events from includePartialMessages
	// This provides real-time updates as the SDK generates content
	const event = msg.event;

	switch (event.type) {
		case "content_block_start":
			return handleContentBlockStart(event, state, ids);
		case "content_block_delta":
			return handleContentBlockDelta(event, state, ids);
		case "content_block_stop":
			return handleContentBlockStop(event, state, ids);
		case "message_start":
			// Start of assistant message
			return [createStartChunk(ids.messageId)];
		default:
			return [];
	}
}

function handleContentBlockStart(
	event: StreamEvent,
	state: StreamState,
	_ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Check what type of content block is starting
	if (event.content_block?.type === "tool_use") {
		const toolUse = event.content_block;
		const toolCallId = toolUse.id;
		const toolName = toolUse.name;

		// Ensure required fields are present
		if (!toolCallId || !toolName) {
			return chunks;
		}

		const toolInput = toolUse.input || {}; // Capture initial input if available

		console.log(
			`[SDK] Tool use starting: ${toolName} (${toolCallId})`,
			`Input:`,
			JSON.stringify(toolInput),
		);

		// Emit tool-input-start
		chunks.push({
			type: "tool-input-start",
			toolCallId,
			toolName,
			dynamic: true,
		});

		// Initialize tool tracking state with input
		if (!state.toolStates.has(toolCallId)) {
			state.toolStates.set(toolCallId, {
				state: "input-streaming",
				inputAvailableSent: false,
				lastRawInput: toolInput, // Store the initial (empty) input
				lastTitle: toolName,
				inputJsonBuffer: "", // Buffer for accumulating input_json_delta
			});
		}
	}

	// Extended thinking/reasoning block
	if (event.content_block?.type === "thinking") {
		// Thinking blocks will emit reasoning-start via createReasoningChunks
		// when the first delta arrives
	}

	return chunks;
}

function handleContentBlockDelta(
	event: StreamEvent,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	// Incremental content update
	if (event.delta?.type === "text_delta" && event.delta.text) {
		return createTextChunks(event.delta.text, state, ids);
	}

	// Extended thinking/reasoning delta
	if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
		return createReasoningChunks(event.delta.thinking, state, ids);
	}

	// Tool input is being streamed
	if (event.delta?.type === "input_json_delta") {
		const chunks: UIMessageChunk[] = [];
		const partialJson = event.delta.partial_json ?? "";

		// Find the tool state for this block index
		// Since we don't have the tool ID in the delta event, we need to find the most recent
		// tool that's in input-streaming state
		for (const [toolCallId, toolState] of state.toolStates.entries()) {
			if (
				toolState.state === "input-streaming" &&
				!toolState.inputAvailableSent
			) {
				// Accumulate the JSON string
				if (!toolState.inputJsonBuffer) {
					toolState.inputJsonBuffer = "";
				}
				toolState.inputJsonBuffer += partialJson;

				// Emit the text delta immediately for streaming display
				if (partialJson) {
					chunks.push({
						type: "tool-input-delta",
						toolCallId,
						inputTextDelta: partialJson,
					});
				}

				// Try to parse the accumulated JSON to update lastRawInput
				try {
					const parsed = JSON.parse(toolState.inputJsonBuffer);
					toolState.lastRawInput = parsed;
				} catch {
					// Not yet complete JSON, wait for more deltas
				}

				// Only process the first matching tool
				break;
			}
		}

		return chunks;
	}

	return [];
}

function handleContentBlockStop(
	_event: StreamEvent,
	state: StreamState,
	_ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Find the tool use block that just stopped
	// We need to check if this is a tool block by looking at the tool states
	// When a tool_use block stops, we emit tool-input-available

	// Note: The SDK doesn't give us the full content_block in the stop event
	// We need to track the block index and match it to tool state
	// For now, we'll emit tool-input-available for all pending tools

	for (const [toolCallId, toolState] of state.toolStates.entries()) {
		if (
			toolState.state === "input-streaming" &&
			!toolState.inputAvailableSent
		) {
			chunks.push({
				type: "tool-input-available",
				toolCallId,
				toolName: toolState.lastTitle || "unknown",
				input: toolState.lastRawInput || {},
				dynamic: true,
			});

			toolState.inputAvailableSent = true;
			toolState.state = "input-available";
		}
	}

	return chunks;
}
