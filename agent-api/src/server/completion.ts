import type {
	SessionNotification,
	ToolCall,
	ToolCallContent,
	ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { UIMessage } from "ai";
import type { ACPClient } from "../acp/client.js";
import {
	createUIMessage,
	generateMessageId,
	uiMessageToContentBlocks,
} from "../acp/translate.js";
import type {
	ChatConflictResponse,
	ChatRequest,
	ChatStartedResponse,
	ErrorResponse,
} from "../api/types.js";
import { checkCredentialsChanged } from "../credentials/credentials.js";
import {
	addCompletionEvent,
	addMessage,
	clearCompletionEvents,
	finishCompletion,
	getCompletionState,
	getLastAssistantMessage,
	isCompletionRunning,
	startCompletion,
	updateMessage,
} from "../store/session.js";
import {
	createBlockIds,
	createErrorChunk,
	createFinishChunks,
	createStartChunk,
	createStreamState,
	extractToolName,
	extractToolOutput,
	sessionUpdateToChunks,
} from "./stream.js";

type ToolUpdate = (ToolCall | ToolCallUpdate) & {
	sessionUpdate: "tool_call" | "tool_call_update";
};

export type StartCompletionResult =
	| { ok: true; status: 202; response: ChatStartedResponse }
	| { ok: false; status: 409; response: ChatConflictResponse }
	| { ok: false; status: 400; response: ErrorResponse };

/**
 * Attempt to start a chat completion. Validates the request, checks for
 * conflicts, and starts the completion in the background if successful.
 *
 * Returns a result object with the appropriate response and status code.
 */
export function tryStartCompletion(
	acpClient: ACPClient,
	body: ChatRequest,
	credentialsHeader: string | null,
): StartCompletionResult {
	const completionId = crypto.randomUUID().slice(0, 8);
	const log = (data: Record<string, unknown>) =>
		console.log(JSON.stringify({ completionId, ...data }));

	// Check if a completion is already running
	if (isCompletionRunning()) {
		const state = getCompletionState();
		log({ event: "conflict", existingCompletionId: state.completionId });
		return {
			ok: false,
			status: 409,
			response: {
				error: "completion_in_progress",
				completionId: state.completionId || "unknown",
			},
		};
	}

	const { messages: inputMessages } = body;

	if (!inputMessages || !Array.isArray(inputMessages)) {
		return {
			ok: false,
			status: 400,
			response: { error: "messages array required" },
		};
	}

	// Get the last user message to send
	const lastUserMessage = inputMessages.filter((m) => m.role === "user").pop();
	if (!lastUserMessage) {
		return {
			ok: false,
			status: 400,
			response: { error: "No user message found" },
		};
	}

	// Mark completion as started (atomically check and set)
	if (!startCompletion(completionId)) {
		// Race condition - another request started between our check and now
		const state = getCompletionState();
		log({ event: "conflict_race", existingCompletionId: state.completionId });
		return {
			ok: false,
			status: 409,
			response: {
				error: "completion_in_progress",
				completionId: state.completionId || "unknown",
			},
		};
	}

	log({ event: "started" });

	// Check for credential changes
	const { changed: credentialsChanged, env: credentialEnv } =
		checkCredentialsChanged(credentialsHeader);

	// Run completion in background (don't await)
	runCompletion(
		acpClient,
		completionId,
		lastUserMessage,
		credentialsChanged,
		credentialEnv,
		log,
	);

	return {
		ok: true,
		status: 202,
		response: { completionId, status: "started" },
	};
}

/**
 * Run a completion in the background. This function does not block -
 * it starts the completion and returns immediately. The completion
 * continues running even if the client disconnects.
 */
function runCompletion(
	acpClient: ACPClient,
	_completionId: string,
	lastUserMessage: UIMessage,
	credentialsChanged: boolean,
	credentialEnv: Record<string, string>,
	log: (data: Record<string, unknown>) => void,
): void {
	// Run asynchronously without blocking the caller
	(async () => {
		// Clear any stale events from previous completions
		clearCompletionEvents();

		try {
			// If credentials changed, restart with new environment
			if (credentialsChanged) {
				await acpClient.updateEnvironment({ env: credentialEnv });
			}

			// Ensure connected and session exists BEFORE adding messages
			// (ensureSession may clear messages when creating a new session)
			if (!acpClient.isConnected) {
				await acpClient.connect();
			}
			await acpClient.ensureSession();

			// Use the incoming UIMessage directly, ensuring it has an ID
			const userMessage: UIMessage = {
				...lastUserMessage,
				id: lastUserMessage.id || generateMessageId(),
			};
			addMessage(userMessage);

			// Create assistant message placeholder
			const assistantMessage = createUIMessage("assistant");
			addMessage(assistantMessage);

			// Convert to ACP format
			const contentBlocks = uiMessageToContentBlocks(userMessage);

			// Create stream state for generating UIMessageChunk events
			const streamState = createStreamState();
			const blockIds = createBlockIds(assistantMessage.id);

			// Send start event
			const startChunk = createStartChunk(assistantMessage.id);
			addCompletionEvent(startChunk);

			// Set up update callback to aggregate messages and generate events
			const handleUpdate = createUpdateHandler(log, streamState, blockIds);
			acpClient.setUpdateCallback(handleUpdate);

			// Send prompt to ACP and wait for completion
			await acpClient.prompt(contentBlocks);

			// Send finish events
			for (const chunk of createFinishChunks(streamState, blockIds)) {
				addCompletionEvent(chunk);
			}

			log({ event: "completed" });
			finishCompletion();
		} catch (error) {
			const errorText = extractErrorMessage(error);
			log({ event: "error", error: errorText });
			// Send error event to SSE stream so the client receives it
			addCompletionEvent(createErrorChunk(errorText));
			finishCompletion(errorText);
		} finally {
			acpClient.setUpdateCallback(null);
		}
	})();
}

/**
 * Create an update handler callback for processing ACP session updates.
 * Accumulates message parts in memory, triggers persistence, and stores
 * UIMessageChunk events for SSE replay.
 */
function createUpdateHandler(
	log: (data: Record<string, unknown>) => void,
	streamState: ReturnType<typeof createStreamState>,
	blockIds: ReturnType<typeof createBlockIds>,
): (params: SessionNotification) => void {
	// Track current text part index for accumulating text chunks.
	// When a tool call is seen, we reset this so the next text creates a new part.
	let currentTextPartIndex: number | null = null;

	return (params: SessionNotification) => {
		const update = params.update;

		// Log session update from ACP
		log({ sessionUpdate: update });

		// Generate UIMessageChunk events for SSE replay
		const chunks = sessionUpdateToChunks(update, streamState, blockIds);
		for (const chunk of chunks) {
			addCompletionEvent(chunk);
		}

		// Update the assistant message in store based on update type
		const currentMsg = getLastAssistantMessage();
		if (!currentMsg) return;

		if (
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
		) {
			currentTextPartIndex = handleTextChunk(
				currentMsg,
				update.content.text,
				currentTextPartIndex,
			);
		} else if (
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update"
		) {
			// Tool call interrupts text - next text chunk should start a new part
			currentTextPartIndex = null;
			handleToolUpdate(currentMsg, update);
		} else if (
			update.sessionUpdate === "agent_thought_chunk" &&
			update.content.type === "text"
		) {
			// Reasoning also interrupts text
			currentTextPartIndex = null;
			handleReasoningChunk(currentMsg, update.content.text);
		}
	};
}

/**
 * Handle a text chunk update - accumulate into existing part or create new one.
 * Returns the current text part index.
 */
function handleTextChunk(
	msg: UIMessage,
	text: string,
	currentIndex: number | null,
): number {
	if (currentIndex !== null && msg.parts[currentIndex]?.type === "text") {
		// Append to existing text part
		const textPart = msg.parts[currentIndex];
		if (textPart.type === "text") {
			textPart.text += text;
		}
	} else {
		// Start a new text part
		currentIndex = msg.parts.length;
		msg.parts.push({ type: "text", text });
	}
	updateMessage(msg.id, { parts: msg.parts });
	return currentIndex;
}

/**
 * Handle a tool call or tool call update.
 */
function handleToolUpdate(msg: UIMessage, update: ToolUpdate): void {
	const toolCallId = update.toolCallId;
	const existingToolPart = msg.parts.find(
		(p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId,
	);

	// Extract tool name from _meta.claudeCode.toolName, falling back to title
	const meta = update._meta as { [key: string]: unknown } | null | undefined;
	const toolName = extractToolName(update.title ?? undefined, meta);
	const content = update.content as ToolCallContent[] | null | undefined;

	if (existingToolPart && existingToolPart.type === "dynamic-tool") {
		existingToolPart.toolName = toolName;
		if (update.title) {
			existingToolPart.title = update.title;
		}
		if (update.rawInput !== undefined) {
			existingToolPart.input = update.rawInput;
		}
		if (update.status === "completed") {
			existingToolPart.state = "output-available";
			existingToolPart.output = extractToolOutput(
				update.rawOutput,
				content,
				meta,
			);
		} else if (update.status === "failed") {
			existingToolPart.state = "output-error";
			const output = extractToolOutput(update.rawOutput, content, meta);
			existingToolPart.errorText = String(output || "Tool call failed");
		} else if (update.status === "in_progress") {
			existingToolPart.state = "input-available";
		}
	} else {
		msg.parts.push({
			type: "dynamic-tool",
			toolCallId,
			toolName,
			title: update.title ?? undefined,
			state: "input-streaming",
			input: update.rawInput,
		});
	}
	updateMessage(msg.id, { parts: msg.parts });
}

/**
 * Handle a reasoning/thought chunk.
 */
function handleReasoningChunk(msg: UIMessage, text: string): void {
	msg.parts.push({ type: "reasoning", text });
	updateMessage(msg.id, { parts: msg.parts });
}

/**
 * Extract error message from various error types (including JSON-RPC errors).
 */
function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (error && typeof error === "object") {
		const errorObj = error as Record<string, unknown>;
		if (typeof errorObj.message === "string") {
			let errorText = errorObj.message;
			// Include details from data.details if available (JSON-RPC format)
			if (errorObj.data && typeof errorObj.data === "object") {
				const data = errorObj.data as Record<string, unknown>;
				if (typeof data.details === "string") {
					errorText = `${errorText}: ${data.details}`;
				}
			}
			return errorText;
		}
	}
	return "Unknown error";
}
