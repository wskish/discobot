/**
 * UIMessage Stream Protocol handler.
 *
 * This module provides utilities for generating UIMessageChunk events
 * that conform to the Vercel AI SDK's UIMessage Stream protocol v1.
 *
 * The protocol requires proper start/delta/end sequences for:
 * - Text: text-start → text-delta* → text-end
 * - Reasoning: reasoning-start → reasoning-delta* → reasoning-end
 * - Tools: tool-input-start → tool-input-available → tool-output-available
 * - Message: start → ... → finish
 */

import type { DynamicToolUIPart, UIMessageChunk } from "ai";

/**
 * Tracks state for proper start/delta/end sequences in UIMessage Stream protocol.
 *
 * Each content type (text, reasoning) needs unique IDs for each block.
 * When switching between content types (e.g., text → tool → text),
 * we must close the current block and start a new one with a new ID.
 */
export interface StreamState {
	/** Current text block ID, null if no text block is open */
	currentTextBlockId: string | null;
	/** Current reasoning block ID, null if no reasoning block is open */
	currentReasoningBlockId: string | null;
	/** Counter for generating unique text block IDs */
	textBlockCounter: number;
	/** Counter for generating unique reasoning block IDs */
	reasoningBlockCounter: number;
	/** Map of toolCallId → last emitted state to avoid duplicate events */
	toolStates: Map<string, DynamicToolUIPart["state"]>;
}

/**
 * Creates initial stream state.
 */
export function createStreamState(): StreamState {
	return {
		currentTextBlockId: null,
		currentReasoningBlockId: null,
		textBlockCounter: 0,
		reasoningBlockCounter: 0,
		toolStates: new Map(),
	};
}

/**
 * Message ID container for generating block IDs.
 */
export interface StreamBlockIds {
	messageId: string;
}

/**
 * Creates block IDs container from a message ID.
 */
export function createBlockIds(messageId: string): StreamBlockIds {
	return { messageId };
}

/**
 * Generates a unique text block ID.
 */
function generateTextBlockId(state: StreamState, ids: StreamBlockIds): string {
	state.textBlockCounter++;
	return `text-${ids.messageId}-${state.textBlockCounter}`;
}

/**
 * Generates a unique reasoning block ID.
 */
function generateReasoningBlockId(
	state: StreamState,
	ids: StreamBlockIds,
): string {
	state.reasoningBlockCounter++;
	return `reasoning-${ids.messageId}-${state.reasoningBlockCounter}`;
}

/**
 * Generates the message start chunk.
 */
export function createStartChunk(messageId: string): UIMessageChunk {
	return {
		type: "start",
		messageId,
	};
}

/**
 * Closes any open non-text blocks (reasoning) before text content.
 * Returns chunks to close those blocks.
 */
function closeNonTextBlocks(state: StreamState): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	if (state.currentReasoningBlockId) {
		chunks.push({
			type: "reasoning-end",
			id: state.currentReasoningBlockId,
		});
		state.currentReasoningBlockId = null;
	}

	return chunks;
}

/**
 * Closes any open non-reasoning blocks (text) before reasoning content.
 * Returns chunks to close those blocks.
 */
function closeNonReasoningBlocks(state: StreamState): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	if (state.currentTextBlockId) {
		chunks.push({
			type: "text-end",
			id: state.currentTextBlockId,
		});
		state.currentTextBlockId = null;
	}

	return chunks;
}

/**
 * Closes any open text/reasoning blocks before tool content.
 * Returns chunks to close those blocks.
 */
function closeContentBlocks(state: StreamState): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	if (state.currentTextBlockId) {
		chunks.push({
			type: "text-end",
			id: state.currentTextBlockId,
		});
		state.currentTextBlockId = null;
	}

	if (state.currentReasoningBlockId) {
		chunks.push({
			type: "reasoning-end",
			id: state.currentReasoningBlockId,
		});
		state.currentReasoningBlockId = null;
	}

	return chunks;
}

/**
 * Generates chunks for a text part.
 * - Closes any open reasoning block first
 * - Opens a new text block if none is open
 * - Emits text-delta
 */
export function createTextChunks(
	text: string,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close reasoning if open (switching content types)
	chunks.push(...closeNonTextBlocks(state));

	// Open new text block if needed
	if (!state.currentTextBlockId) {
		const blockId = generateTextBlockId(state, ids);
		state.currentTextBlockId = blockId;
		chunks.push({
			type: "text-start",
			id: blockId,
		});
	}

	chunks.push({
		type: "text-delta",
		id: state.currentTextBlockId,
		delta: text,
	});

	return chunks;
}

/**
 * Generates chunks for a reasoning part.
 * - Closes any open text block first
 * - Opens a new reasoning block if none is open
 * - Emits reasoning-delta
 */
export function createReasoningChunks(
	text: string,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close text if open (switching content types)
	chunks.push(...closeNonReasoningBlocks(state));

	// Open new reasoning block if needed
	if (!state.currentReasoningBlockId) {
		const blockId = generateReasoningBlockId(state, ids);
		state.currentReasoningBlockId = blockId;
		chunks.push({
			type: "reasoning-start",
			id: blockId,
		});
	}

	chunks.push({
		type: "reasoning-delta",
		id: state.currentReasoningBlockId,
		delta: text,
	});

	return chunks;
}

/**
 * Generates chunks for a tool part based on its state transitions.
 * - Closes any open text/reasoning blocks first
 * - Returns appropriate tool events based on state changes.
 */
export function createToolChunks(
	toolPart: DynamicToolUIPart,
	state: StreamState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close any open text/reasoning blocks before tool content
	chunks.push(...closeContentBlocks(state));

	const prevState = state.toolStates.get(toolPart.toolCallId);

	// Send tool-input-start on first encounter
	if (!prevState) {
		chunks.push({
			type: "tool-input-start",
			toolCallId: toolPart.toolCallId,
			toolName: toolPart.toolName,
			dynamic: true,
		});
	}

	// Emit appropriate event based on state transition
	if (toolPart.state === "input-available" && prevState !== "input-available") {
		chunks.push({
			type: "tool-input-available",
			toolCallId: toolPart.toolCallId,
			toolName: toolPart.toolName,
			input: toolPart.input,
			dynamic: true,
		});
	} else if (
		toolPart.state === "output-available" &&
		prevState !== "output-available"
	) {
		chunks.push({
			type: "tool-output-available",
			toolCallId: toolPart.toolCallId,
			output: toolPart.output,
			dynamic: true,
		});
	} else if (
		toolPart.state === "output-error" &&
		prevState !== "output-error"
	) {
		chunks.push({
			type: "tool-output-error",
			toolCallId: toolPart.toolCallId,
			errorText: toolPart.errorText || "Tool execution failed",
			dynamic: true,
		});
	}

	// Update tracked state
	state.toolStates.set(toolPart.toolCallId, toolPart.state);

	return chunks;
}

/**
 * Generates finish chunks (text-end, reasoning-end, finish).
 * Closes any open blocks and emits the finish event.
 */
export function createFinishChunks(
	state: StreamState,
	_ids: StreamBlockIds,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close any open blocks
	chunks.push(...closeContentBlocks(state));

	chunks.push({
		type: "finish",
	});

	return chunks;
}

/**
 * Creates an error chunk.
 */
export function createErrorChunk(errorText: string): UIMessageChunk {
	return {
		type: "error",
		errorText,
	};
}

/**
 * Union type for parts that can be converted to stream chunks.
 */
export type StreamablePart =
	| { type: "text"; text: string }
	| { type: "reasoning"; text: string }
	| DynamicToolUIPart;

/**
 * Generates UIMessageChunks for a streamable part.
 */
export function partToChunks(
	part: StreamablePart,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	switch (part.type) {
		case "text":
			return createTextChunks(part.text, state, ids);
		case "reasoning":
			return createReasoningChunks(part.text, state, ids);
		case "dynamic-tool":
			return createToolChunks(part, state);
		default:
			return [];
	}
}
