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

import type {
	Plan,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { ProviderMetadata, UIMessageChunk } from "ai";

/**
 * Claude Code specific metadata extension.
 * Claude Code uses _meta.claudeCode to provide additional tool information
 * that isn't part of the standard ACP spec.
 */
interface ClaudeCodeMeta {
	/** The actual tool name (e.g., "Bash", "Read", "Edit") */
	toolName?: string;
	/** Raw tool response with stdout/stderr for terminal tools */
	toolResponse?: {
		stdout?: string;
		stderr?: string;
		interrupted?: boolean;
		isImage?: boolean;
	};
}

/**
 * Extract Claude Code metadata from ACP _meta field.
 */
export function getClaudeCodeMeta(
	meta?: { [key: string]: unknown } | null,
): ClaudeCodeMeta | undefined {
	if (!meta || typeof meta !== "object") return undefined;
	const claudeCode = meta.claudeCode;
	if (!claudeCode || typeof claudeCode !== "object") return undefined;
	return claudeCode as ClaudeCodeMeta;
}

/**
 * Extract the tool name from an ACP tool call/update.
 * Priority: standard field (none in ACP) → _meta.claudeCode.toolName → title → "unknown"
 */
export function extractToolName(
	title?: string,
	meta?: { [key: string]: unknown } | null,
): string {
	const claudeCode = getClaudeCodeMeta(meta);
	// Prefer Claude Code's toolName (actual tool like "Bash")
	// Fall back to title (display name like "`ls -la`")
	return claudeCode?.toolName || title || "unknown";
}

/**
 * Extract the display title from an ACP tool call/update.
 * This is the human-readable description (e.g., "`ls -la /tmp`").
 */
function extractTitle(title?: string): string | undefined {
	return title;
}

/**
 * Extract tool output from an ACP tool call/update.
 * Priority: rawOutput → _meta.claudeCode.toolResponse → content array → undefined
 */
export function extractToolOutput(
	rawOutput: unknown,
	content?: Array<ToolCallContent> | null,
	meta?: { [key: string]: unknown } | null,
): unknown {
	// 1. Standard ACP field
	if (rawOutput !== undefined && rawOutput !== null) {
		return rawOutput;
	}

	// 2. Claude Code specific: toolResponse in _meta
	const claudeCode = getClaudeCodeMeta(meta);
	if (claudeCode?.toolResponse) {
		return claudeCode.toolResponse;
	}

	// 3. Extract from content array (formatted output)
	if (content && content.length > 0) {
		// Try to extract text from content blocks
		const textParts: string[] = [];
		for (const item of content) {
			if (item.type === "content" && item.content) {
				const block = item.content;
				if (block && typeof block === "object" && "text" in block) {
					textParts.push((block as { text: string }).text);
				}
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return undefined;
}

/**
 * Build providerMetadata from Claude Code _meta for input events.
 * This allows the UI to access Claude-specific information.
 */
function buildProviderMetadata(
	meta?: { [key: string]: unknown } | null,
): ProviderMetadata | undefined {
	const claudeCode = getClaudeCodeMeta(meta);
	if (!claudeCode) return undefined;
	// Cast to expected type - claudeCode metadata is JSON-serializable
	return { claudeCode } as unknown as ProviderMetadata;
}

/** Tool state values for tracking emitted events */
type ToolState =
	| "input-streaming"
	| "input-available"
	| "output-available"
	| "output-error";

/**
 * Tracked state for a single tool call.
 */
interface ToolTrackingState {
	/** Last emitted state */
	state: ToolState;
	/** Whether tool-input-available has been sent */
	inputAvailableSent: boolean;
	/** Last seen rawInput value (for use in fallback input-available) */
	lastRawInput: unknown;
	/** Last seen title (for use in fallback input-available) */
	lastTitle: string | undefined;
	/** Buffer for accumulating streaming JSON input (SDK-specific) */
	inputJsonBuffer?: string;
}

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
	/** Map of toolCallId → tracking state for tool events */
	toolStates: Map<string, ToolTrackingState>;
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
 * Maps ACP tool status to stream state.
 */
function toolStatusToState(
	status?: "pending" | "in_progress" | "completed" | "failed" | null,
): ToolState {
	switch (status) {
		case "completed":
			return "output-available";
		case "failed":
			return "output-error";
		case "in_progress":
			return "input-available";
		default:
			return "input-streaming";
	}
}

/**
 * Common parameters for generating tool chunks.
 */
interface ToolChunkParams {
	toolCallId: string;
	status?: "pending" | "in_progress" | "completed" | "failed" | null;
	title?: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	content?: Array<ToolCallContent> | null;
	_meta?: { [key: string]: unknown } | null;
}

/**
 * Generates chunks for tool call events.
 * Handles the full lifecycle:
 * - tool-input-start: First encounter
 * - tool-input-delta: When rawInput changes while pending
 * - tool-input-available: When in_progress, or as fallback before output
 * - tool-output-available/tool-output-error: When completed/failed
 */
function createToolChunksInternal(
	params: ToolChunkParams,
	state: StreamState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close any open text/reasoning blocks before tool content
	chunks.push(...closeContentBlocks(state));

	const prevTracking = state.toolStates.get(params.toolCallId);
	const currentState = toolStatusToState(params.status);

	// Extract fields with fallbacks to Claude Code extensions
	const toolName = extractToolName(params.title, params._meta);
	const title = extractTitle(params.title);
	const providerMetadata = buildProviderMetadata(params._meta);

	// Track the best known input and title (use current if available, else use previous)
	const effectiveRawInput =
		params.rawInput !== undefined
			? params.rawInput
			: (prevTracking?.lastRawInput ?? {});
	const effectiveTitle = title ?? prevTracking?.lastTitle;

	// Send tool-input-start on first encounter
	if (!prevTracking) {
		chunks.push({
			type: "tool-input-start",
			toolCallId: params.toolCallId,
			toolName,
			title,
			providerMetadata,
			dynamic: true,
		});
	}

	// Track whether we've sent input-available
	let inputAvailableSent = prevTracking?.inputAvailableSent ?? false;

	// Send input-available when transitioning to in_progress (if not already sent)
	if (currentState === "input-available" && !inputAvailableSent) {
		chunks.push({
			type: "tool-input-available",
			toolCallId: params.toolCallId,
			toolName,
			title: effectiveTitle,
			input: effectiveRawInput,
			providerMetadata,
			dynamic: true,
		});
		inputAvailableSent = true;
	}

	// Handle output states
	if (currentState === "output-available") {
		// Fallback: send input-available before output if we never sent it
		if (!inputAvailableSent) {
			chunks.push({
				type: "tool-input-available",
				toolCallId: params.toolCallId,
				toolName,
				title: effectiveTitle,
				input: effectiveRawInput,
				providerMetadata,
				dynamic: true,
			});
			inputAvailableSent = true;
		}

		// Only send output-available if we haven't already
		if (prevTracking?.state !== "output-available") {
			const output = extractToolOutput(
				params.rawOutput,
				params.content,
				params._meta,
			);
			chunks.push({
				type: "tool-output-available",
				toolCallId: params.toolCallId,
				output,
				dynamic: true,
			});
		}
	} else if (currentState === "output-error") {
		// Fallback: send input-available before error if we never sent it
		if (!inputAvailableSent) {
			chunks.push({
				type: "tool-input-available",
				toolCallId: params.toolCallId,
				toolName,
				title: effectiveTitle,
				input: effectiveRawInput,
				providerMetadata,
				dynamic: true,
			});
			inputAvailableSent = true;
		}

		// Only send output-error if we haven't already
		if (prevTracking?.state !== "output-error") {
			const output = extractToolOutput(
				params.rawOutput,
				params.content,
				params._meta,
			);
			chunks.push({
				type: "tool-output-error",
				toolCallId: params.toolCallId,
				errorText: String(output || "Tool call failed"),
				dynamic: true,
			});
		}
	}

	// Update tracked state (preserve last known input/title if not provided in this update)
	state.toolStates.set(params.toolCallId, {
		state: currentState,
		inputAvailableSent,
		lastRawInput: effectiveRawInput,
		lastTitle: effectiveTitle,
	});

	return chunks;
}

/**
 * Generates chunks for an ACP ToolCall.
 * - Closes any open text/reasoning blocks first
 * - Returns appropriate tool events based on state.
 * - Extracts tool metadata from standard ACP fields first, then Claude Code extensions.
 */
export function createToolCallChunks(
	toolCall: ToolCall,
	state: StreamState,
): UIMessageChunk[] {
	return createToolChunksInternal(
		{
			toolCallId: toolCall.toolCallId,
			status: toolCall.status,
			title: toolCall.title,
			rawInput: toolCall.rawInput,
			rawOutput: toolCall.rawOutput,
			content: toolCall.content,
			_meta: toolCall._meta,
		},
		state,
	);
}

/**
 * Generates chunks for an ACP ToolCallUpdate.
 * - Closes any open text/reasoning blocks first
 * - Returns appropriate tool events based on state changes.
 * - Extracts tool metadata from standard ACP fields first, then Claude Code extensions.
 */
export function createToolCallUpdateChunks(
	update: ToolCallUpdate,
	state: StreamState,
): UIMessageChunk[] {
	return createToolChunksInternal(
		{
			toolCallId: update.toolCallId,
			status: update.status,
			title: update.title ?? undefined,
			rawInput: update.rawInput,
			rawOutput: update.rawOutput,
			content: update.content,
			_meta: update._meta,
		},
		state,
	);
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
 * Generates chunks for an ACP Plan update.
 * Creates a synthetic tool call that represents the plan state.
 * - Closes any open text/reasoning blocks first
 * - Returns tool events with plan entries as output
 */
export function createPlanToolChunks(
	plan: Plan,
	state: StreamState,
): UIMessageChunk[] {
	const chunks: UIMessageChunk[] = [];

	// Close any open text/reasoning blocks before plan content
	chunks.push(...closeContentBlocks(state));

	// Generate a unique tool call ID for this plan update
	const toolCallId = `plan-${Date.now()}`;
	const toolName = "TodoWrite";

	// Send tool-input-start
	chunks.push({
		type: "tool-input-start",
		toolCallId,
		toolName,
		title: "Plan",
		dynamic: true,
	});

	// Send tool-input-available with empty input
	chunks.push({
		type: "tool-input-available",
		toolCallId,
		toolName,
		title: "Plan",
		input: {},
		dynamic: true,
	});

	// Send tool-output-available with plan entries
	chunks.push({
		type: "tool-output-available",
		toolCallId,
		output: plan.entries,
		dynamic: true,
	});

	// Track the tool state
	state.toolStates.set(toolCallId, {
		state: "output-available",
		inputAvailableSent: true,
		lastRawInput: {},
		lastTitle: "Plan",
	});

	return chunks;
}

/**
 * Generates UIMessageChunks for an ACP SessionUpdate.
 * Returns empty array for unhandled update types.
 */
export function sessionUpdateToChunks(
	update: SessionUpdate,
	state: StreamState,
	ids: StreamBlockIds,
): UIMessageChunk[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			if (update.content.type === "text") {
				return createTextChunks(update.content.text, state, ids);
			}
			break;

		case "agent_thought_chunk":
			if (update.content.type === "text") {
				return createReasoningChunks(update.content.text, state, ids);
			}
			break;

		case "tool_call":
			return createToolCallChunks(update, state);

		case "tool_call_update":
			return createToolCallUpdateChunks(update, state);

		case "plan":
			return createPlanToolChunks(update, state);
	}

	return [];
}
