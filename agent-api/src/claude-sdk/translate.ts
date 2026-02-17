/**
 * Translates Claude SDK messages to UIMessageChunk events.
 *
 * This module converts SDKMessage types from @anthropic-ai/claude-agent-sdk
 * to the UIMessageChunk protocol used by the Vercel AI SDK.
 *
 * Key design principles:
 * - No external state dependencies - TranslationState is local per message
 * - Deterministic ID generation using {type}-{uuid}-{index} pattern
 * - Exhaustive content block handling with type safety
 * - Uses stream event index field for proper block correlation
 */

import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	BetaContentBlock,
	BetaRawContentBlockDeltaEvent,
	BetaRawContentBlockStartEvent,
	BetaRawContentBlockStopEvent,
	BetaRawMessageStartEvent,
	BetaRawMessageStreamEvent,
	BetaTextBlock,
	BetaThinkingBlock,
	BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { UIMessageChunk } from "ai";

// ============================================================================
// Types
// ============================================================================

/**
 * Local state for tracking streaming translation.
 * Scoped to an entire agentic loop (multiple API calls per prompt).
 */
export interface TranslationState {
	/** UUID of the current message being translated */
	messageUuid: string;
	/** Track which indices have open text blocks (need text-end on stop) */
	openTextIndices: Set<number>;
	/** Track which indices have open reasoning blocks (need reasoning-end on stop) */
	openReasoningIndices: Set<number>;
	/** Map block index to toolCallId for proper correlation */
	indexToToolCallId: Map<number, string>;
	/** Tool state tracking by toolCallId */
	toolStates: Map<string, ToolState>;
	/** Whether we've emitted the initial 'start' event for this prompt */
	hasEmittedStart: boolean;
	/** The message ID used for the overall response (first message's ID) */
	responseMessageId: string;
	/** Whether we need to emit finish-step (deferred until tool results arrive) */
	needsFinishStep: boolean;
}

interface ToolState {
	/** Whether tool-input-available has been sent */
	inputAvailableSent: boolean;
	/** Tool name for display */
	toolName: string;
	/** Accumulated input object */
	input: unknown;
	/** Buffer for streaming JSON input */
	inputJsonBuffer: string;
	/** Block index this tool belongs to */
	index: number;
}

/**
 * Content block types that we handle for translation.
 * This is a subset of BetaContentBlock that we care about.
 */
type TranslatableContentBlock =
	| BetaTextBlock
	| BetaThinkingBlock
	| BetaToolUseBlock
	| {
			type: "tool_result";
			tool_use_id: string;
			content?: unknown;
			is_error?: boolean;
	  };

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a deterministic block ID from message uuid, block index, and type.
 * This ensures IDs are consistent between streaming and JSONL reading.
 */
export function generateBlockId(
	uuid: string,
	index: number,
	type: "text" | "reasoning",
): string {
	return `${type}-${uuid}-${index}`;
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Create a new TranslationState for a message.
 */
export function createTranslationState(messageUuid: string): TranslationState {
	return {
		messageUuid,
		openTextIndices: new Set(),
		openReasoningIndices: new Set(),
		indexToToolCallId: new Map(),
		toolStates: new Map(),
		hasEmittedStart: false,
		responseMessageId: "",
		needsFinishStep: false,
	};
}

// ============================================================================
// Main Entry Points
// ============================================================================

/**
 * Translate an SDKMessage to UIMessageChunks.
 * Handles all message types: assistant, stream_event, result, system, user.
 *
 * IMPORTANT: During streaming, the SDK emits both incremental stream_events AND
 * complete assistant message snapshots. We ONLY process stream_events during
 * streaming to avoid duplicating content. The assistant messages are used when
 * loading from disk (via translateAssistantMessage directly).
 */
export function translateSDKMessage(
	msg: SDKMessage,
	state: TranslationState,
): UIMessageChunk[] {
	switch (msg.type) {
		case "assistant":
			// During streaming, ignore assistant messages - they're snapshots of
			// content we're already receiving via stream_events. Processing both
			// causes duplicate content and out-of-order events.
			// Assistant messages are only used when loading complete messages from disk.
			return [];

		case "stream_event":
			return translateStreamEvent(msg, state);

		case "result":
			return createFinishChunks(msg, state);

		case "user":
			// User messages may contain tool_result blocks
			return translateUserMessage(msg, state);

		case "system":
			// No chunks emitted for system messages
			return [];

		default:
			// Handle other SDK message types that don't produce UI chunks
			// (SDKStatusMessage, SDKHookProgressMessage, etc.)
			return [];
	}
}

/**
 * Translate a complete SDKAssistantMessage to UIMessageChunks.
 * Used when processing non-streaming or complete messages.
 */
export function translateAssistantMessage(
	msg: SDKAssistantMessage,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];
	// Use the actual API message ID for consistency with streaming
	const messageId = msg.message.id;

	// Emit start chunk
	chunks.push({ type: "start", messageId });

	// Process content blocks
	const content = msg.message.content;
	for (let index = 0; index < content.length; index++) {
		const block = content[index];
		chunks.push(...translateContentBlock(block, messageId, index));
	}

	// Emit finish chunk
	chunks.push({ type: "finish" });

	return chunks;
}

// ============================================================================
// Content Block Translation
// ============================================================================

/**
 * Translate a single content block to UIMessageChunks.
 * Used for both streaming (complete blocks) and JSONL reading.
 */
export function translateContentBlock(
	block: BetaContentBlock | TranslatableContentBlock,
	uuid: string,
	index: number,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	switch (block.type) {
		case "text": {
			// TypeScript narrows block to BetaTextBlock here
			const blockId = generateBlockId(uuid, index, "text");
			chunks.push({ type: "text-start", id: blockId });
			if (block.text) {
				chunks.push({ type: "text-delta", id: blockId, delta: block.text });
			}
			chunks.push({ type: "text-end", id: blockId });
			break;
		}

		case "thinking": {
			// TypeScript narrows block to BetaThinkingBlock here
			const blockId = generateBlockId(uuid, index, "reasoning");
			chunks.push({ type: "reasoning-start", id: blockId });
			if (block.thinking) {
				chunks.push({
					type: "reasoning-delta",
					id: blockId,
					delta: block.thinking,
				});
			}
			chunks.push({ type: "reasoning-end", id: blockId });
			break;
		}

		case "tool_use": {
			// TypeScript narrows block to BetaToolUseBlock here
			chunks.push({
				type: "tool-input-start",
				toolCallId: block.id,
				toolName: block.name,
				dynamic: true,
			});
			chunks.push({
				type: "tool-input-available",
				toolCallId: block.id,
				toolName: block.name,
				input: block.input ?? {},
				dynamic: true,
			});
			break;
		}

		case "tool_result": {
			// TypeScript narrows block to TranslatableContentBlock's tool_result
			chunks.push(
				block.is_error
					? {
							type: "tool-output-error",
							toolCallId: block.tool_use_id,
							errorText: String(block.content ?? "Tool call failed"),
							dynamic: true,
						}
					: {
							type: "tool-output-available",
							toolCallId: block.tool_use_id,
							output: block.content,
							dynamic: true,
						},
			);
			break;
		}

		default: {
			// Unknown block type - log and skip
			// Many BetaContentBlock types exist that we don't need to handle
			// (e.g., server tool results, MCP blocks, etc.)
		}
	}

	return chunks;
}

// ============================================================================
// User Message Translation (for tool results)
// ============================================================================

/**
 * Translate an SDKUserMessage to UIMessageChunks.
 * Extracts tool_result blocks and emits tool-output-available/error chunks.
 * Only emits output events for tools we've seen start events for (tracked in state).
 */
function translateUserMessage(
	msg: SDKUserMessage,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];
	const content = msg.message.content;

	// User messages can be a string or array of content blocks
	if (typeof content === "string") {
		// Plain text user message - no chunks needed
		return [];
	}

	// Process content blocks looking for tool_result
	for (const block of content) {
		if (block.type === "tool_result") {
			// Extract tool result content
			const toolUseId = block.tool_use_id;

			// Only emit output event if we've seen the corresponding tool-input-start
			// This prevents sending tool-output-available for tools from subsessions
			// where we never sent the start event
			if (!state.toolStates.has(toolUseId)) {
				console.warn(
					`[translate] Skipping tool-output-available for unknown tool ID: ${toolUseId}`,
				);
				continue;
			}

			const isError = block.is_error === true;

			// Content can be string or array of content blocks
			let outputContent: unknown;
			if (typeof block.content === "string") {
				outputContent = block.content;
			} else if (Array.isArray(block.content)) {
				// Extract text from content blocks
				const textParts = block.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text);
				outputContent = textParts.join("\n");
			} else {
				outputContent = block.content;
			}

			if (isError) {
				chunks.push({
					type: "tool-output-error",
					toolCallId: toolUseId,
					errorText: String(outputContent ?? "Tool call failed"),
					dynamic: true,
				});
			} else {
				chunks.push({
					type: "tool-output-available",
					toolCallId: toolUseId,
					output: outputContent,
					dynamic: true,
				});
			}
		}
	}

	return chunks;
}

// ============================================================================
// Stream Event Translation
// ============================================================================

/**
 * Translate a streaming event to UIMessageChunks.
 */
function translateStreamEvent(
	msg: SDKPartialAssistantMessage,
	state: TranslationState,
): UIMessageChunk[] {
	const event: BetaRawMessageStreamEvent = msg.event;

	switch (event.type) {
		case "message_start":
			return handleMessageStart(msg, event, state);

		case "content_block_start":
			return handleContentBlockStart(event, state);

		case "content_block_delta":
			return handleContentBlockDelta(event, state);

		case "content_block_stop":
			return handleContentBlockStop(event, state);

		case "message_delta":
			// message_delta contains usage/stop info - no chunks needed
			return [];

		case "message_stop":
			// Defer finish-step until we've received tool results (if any)
			// This ensures tool-output-available comes before finish-step
			state.needsFinishStep = true;
			return [];

		default:
			return [];
	}
}

function handleMessageStart(
	_msg: SDKPartialAssistantMessage,
	event: BetaRawMessageStartEvent,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Emit deferred finish-step from previous API call (after tool results)
	if (state.needsFinishStep) {
		chunks.push({ type: "finish-step" } as UIMessageChunk);
		state.needsFinishStep = false;
	}

	// Use the actual API message ID (consistent across partial updates)
	const messageId = event.message.id;
	state.messageUuid = messageId;

	// Extract the actual model used from the message
	const modelUsed = event.message.model;

	if (!state.hasEmittedStart) {
		// First message_start in the agentic loop - emit 'start' for the overall response
		state.hasEmittedStart = true;
		state.responseMessageId = messageId;
		chunks.push({
			type: "start",
			messageId,
			...(modelUsed
				? { messageMetadata: { model: `anthropic:${modelUsed}` } }
				: {}),
		});
	} else {
		// Subsequent message_start (after tool use) - emit 'start-step' for this API call
		// Use the original response messageId for consistency
		chunks.push({ type: "start-step" } as UIMessageChunk);
	}

	// Reset block tracking state for new API call
	state.openTextIndices.clear();
	state.openReasoningIndices.clear();
	state.indexToToolCallId.clear();
	state.toolStates.clear();

	return chunks;
}

function handleContentBlockStart(
	event: BetaRawContentBlockStartEvent,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];
	const { index, content_block: block } = event;

	switch (block.type) {
		case "text": {
			const blockId = generateBlockId(state.messageUuid, index, "text");
			state.openTextIndices.add(index);
			chunks.push({ type: "text-start", id: blockId });
			break;
		}

		case "thinking": {
			const blockId = generateBlockId(state.messageUuid, index, "reasoning");
			state.openReasoningIndices.add(index);
			chunks.push({ type: "reasoning-start", id: blockId });
			break;
		}

		case "tool_use": {
			// TypeScript narrows block to BetaToolUseBlock here
			// Track index → toolCallId mapping
			state.indexToToolCallId.set(index, block.id);
			state.toolStates.set(block.id, {
				inputAvailableSent: false,
				toolName: block.name,
				input: block.input ?? {},
				inputJsonBuffer: "",
				index,
			});

			chunks.push({
				type: "tool-input-start",
				toolCallId: block.id,
				toolName: block.name,
				dynamic: true,
			});
			break;
		}

		default:
			// Other block types (server tools, MCP, etc.) - no UI chunks needed
			break;
	}

	return chunks;
}

function handleContentBlockDelta(
	event: BetaRawContentBlockDeltaEvent,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];
	const { index, delta } = event;

	switch (delta.type) {
		case "text_delta": {
			// TypeScript narrows delta to BetaTextDelta
			const blockId = generateBlockId(state.messageUuid, index, "text");
			chunks.push({ type: "text-delta", id: blockId, delta: delta.text });
			break;
		}

		case "thinking_delta": {
			// TypeScript narrows delta to BetaThinkingDelta
			const blockId = generateBlockId(state.messageUuid, index, "reasoning");
			chunks.push({
				type: "reasoning-delta",
				id: blockId,
				delta: delta.thinking,
			});
			break;
		}

		case "input_json_delta": {
			// TypeScript narrows delta to BetaInputJSONDelta
			// Find the tool for this index
			const toolCallId = state.indexToToolCallId.get(index);
			if (!toolCallId) {
				console.warn(`[translate] No tool found for index ${index}`);
				break;
			}

			const toolState = state.toolStates.get(toolCallId);
			if (!toolState) break;

			// Accumulate JSON
			toolState.inputJsonBuffer += delta.partial_json;

			// Emit delta for streaming display
			chunks.push({
				type: "tool-input-delta",
				toolCallId,
				inputTextDelta: delta.partial_json,
			});

			// Try to parse accumulated JSON
			try {
				toolState.input = JSON.parse(toolState.inputJsonBuffer);
			} catch {
				// Not yet complete JSON, continue accumulating
			}
			break;
		}

		case "signature_delta":
			// Thinking block signature - not exposed in UI
			break;
	}

	return chunks;
}

function handleContentBlockStop(
	event: BetaRawContentBlockStopEvent,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];
	const { index } = event;

	// Close text block if open
	if (state.openTextIndices.has(index)) {
		const blockId = generateBlockId(state.messageUuid, index, "text");
		chunks.push({ type: "text-end", id: blockId });
		state.openTextIndices.delete(index);
	}

	// Close reasoning block if open
	if (state.openReasoningIndices.has(index)) {
		const blockId = generateBlockId(state.messageUuid, index, "reasoning");
		chunks.push({ type: "reasoning-end", id: blockId });
		state.openReasoningIndices.delete(index);
	}

	// Finalize tool if this index has a tool
	const toolCallId = state.indexToToolCallId.get(index);
	if (toolCallId) {
		const toolState = state.toolStates.get(toolCallId);
		if (toolState && !toolState.inputAvailableSent) {
			chunks.push({
				type: "tool-input-available",
				toolCallId,
				toolName: toolState.toolName,
				input: toolState.input,
				dynamic: true,
			});
			toolState.inputAvailableSent = true;
		}
	}

	return chunks;
}

// ============================================================================
// Finish Handling
// ============================================================================

/**
 * Create finish chunks for the result message.
 * Closes any orphaned blocks and emits the final finish.
 * Maps Claude SDK stop_reason to AI SDK finishReason.
 */
function createFinishChunks(
	msg: SDKMessage,
	state: TranslationState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Emit deferred finish-step from the last API call
	if (state.needsFinishStep) {
		chunks.push({ type: "finish-step" } as UIMessageChunk);
		state.needsFinishStep = false;
	}

	// Close any remaining open text blocks (safety net)
	for (const index of state.openTextIndices) {
		const blockId = generateBlockId(state.messageUuid, index, "text");
		chunks.push({ type: "text-end", id: blockId });
	}
	state.openTextIndices.clear();

	// Close any remaining open reasoning blocks (safety net)
	for (const index of state.openReasoningIndices) {
		const blockId = generateBlockId(state.messageUuid, index, "reasoning");
		chunks.push({ type: "reasoning-end", id: blockId });
	}
	state.openReasoningIndices.clear();

	// Map Claude SDK stop_reason to AI SDK finishReason
	let finishReason: "stop" | "length" | "tool-calls" | "error" | "other" =
		"stop";
	if (
		msg.type === "result" &&
		"stop_reason" in msg &&
		typeof msg.stop_reason === "string"
	) {
		const stopReason = msg.stop_reason;
		if (stopReason === "end_turn") {
			finishReason = "stop";
		} else if (stopReason === "tool_use") {
			finishReason = "tool-calls";
		} else if (stopReason === "max_tokens") {
			finishReason = "length";
		} else if (stopReason) {
			finishReason = "other";
		}
	}

	// Emit finish for the overall message/response
	chunks.push({ type: "finish", finishReason });

	return chunks;
}
