import type {
	ContentBlock,
	SessionUpdate,
	ToolCall,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { UIMessage } from "ai";
import type {
	ReasoningPart,
	SimpleMessage,
	SimplePart,
	TextPart,
	ToolInvocationPart,
} from "./session.js";

// Re-export types from session
export type {
	SimpleMessage,
	SimplePart,
	TextPart,
	ReasoningPart,
	ToolInvocationPart,
};

/**
 * Convert incoming UIMessage to our SimpleMessage format
 */
export function uiMessageToSimple(message: UIMessage): SimpleMessage {
	const parts: SimplePart[] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "file") {
			parts.push({
				type: "file",
				url: part.url,
				mediaType: part.mediaType,
				filename: part.filename,
			});
		}
		// Skip other part types for user messages
	}

	return {
		id: message.id,
		role: message.role as "user" | "assistant" | "system",
		parts,
	};
}

/**
 * Convert SimpleMessage parts to ACP ContentBlock array
 */
export function simpleMessageToContentBlocks(
	message: SimpleMessage,
): ContentBlock[] {
	const blocks: ContentBlock[] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			blocks.push({
				type: "text",
				text: part.text,
			});
		} else if (part.type === "file") {
			blocks.push({
				type: "resource_link",
				uri: part.url,
				name: part.filename || "file",
				mimeType: part.mediaType,
			});
		}
	}

	return blocks;
}

/**
 * Convert ACP SessionUpdate to a SimplePart
 */
export function sessionUpdateToSimplePart(
	update: SessionUpdate,
): SimplePart | null {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			if (update.content.type === "text") {
				return {
					type: "text",
					text: update.content.text,
				};
			}
			break;

		case "agent_thought_chunk":
			if (update.content.type === "text") {
				return {
					type: "reasoning",
					text: update.content.text,
				};
			}
			break;

		case "tool_call":
			return toolCallToSimplePart(update);

		case "tool_call_update":
			return toolCallUpdateToSimplePart(update);
	}

	return null;
}

/**
 * Convert ACP ToolCall to SimplePart
 */
export function toolCallToSimplePart(toolCall: ToolCall): ToolInvocationPart {
	return {
		type: "tool-invocation",
		toolCallId: toolCall.toolCallId,
		toolName: toolCall.title,
		args: toolCall.rawInput || {},
		state: toolCallStatusToState(toolCall.status),
		result: toolCall.rawOutput,
	};
}

/**
 * Convert ACP ToolCallUpdate to SimplePart
 */
export function toolCallUpdateToSimplePart(
	update: ToolCallUpdate,
): ToolInvocationPart {
	return {
		type: "tool-invocation",
		toolCallId: update.toolCallId,
		toolName: update.title || "unknown",
		args: update.rawInput || {},
		state: toolCallStatusToState(update.status),
		result: update.rawOutput,
	};
}

function toolCallStatusToState(
	status?: "pending" | "in_progress" | "completed" | "failed" | null,
): "partial-call" | "call" | "result" {
	switch (status) {
		case "completed":
		case "failed":
			return "result";
		case "in_progress":
			return "call";
		default:
			return "partial-call";
	}
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a new SimpleMessage
 */
export function createSimpleMessage(
	role: "user" | "assistant",
	parts: SimplePart[] = [],
): SimpleMessage {
	return {
		id: generateMessageId(),
		role,
		parts,
	};
}
