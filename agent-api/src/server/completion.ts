import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { UIMessage } from "ai";
import type { Agent } from "../agent/interface.js";
import { generateMessageId } from "../agent/utils.js";
import type {
	CancelCompletionResponse,
	ChatConflictResponse,
	ChatRequest,
	ChatStartedResponse,
	ErrorResponse,
	NoActiveCompletionResponse,
} from "../api/types.js";
import { checkCredentialsChanged } from "../credentials/credentials.js";
import {
	addCompletionEvent,
	clearCompletionEvents,
	finishCompletion,
	getCompletionState,
	isCompletionRunning,
	startCompletion,
} from "../store/session.js";

const execAsync = promisify(exec);

// Global state for the current completion
let currentAgent: Agent | null = null;
let currentSessionId: string | undefined;
let currentAbortController: AbortController | null = null;

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
	agent: Agent,
	body: ChatRequest,
	credentialsHeader: string | null,
	gitUserName: string | null,
	gitUserEmail: string | null,
	sessionId?: string,
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
		log({
			event: "conflict_race",
			existingCompletionId: state.completionId,
		});
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

	// Store agent and session references for cancellation
	currentAgent = agent;
	currentSessionId = sessionId;
	currentAbortController = new AbortController();

	// Run completion with abort signal in background (don't await)
	runCompletion(
		agent,
		completionId,
		lastUserMessage,
		credentialsChanged,
		credentialEnv,
		gitUserName,
		gitUserEmail,
		log,
		sessionId,
		currentAbortController.signal,
	);

	return {
		ok: true,
		status: 202,
		response: { completionId, status: "started" },
	};
}

export type CancelCompletionResult =
	| { ok: true; status: 200; response: CancelCompletionResponse }
	| { ok: false; status: 409; response: NoActiveCompletionResponse };

/**
 * Attempt to cancel an in-progress chat completion.
 * Returns a result object with the appropriate response and status code.
 */
export function tryCancelCompletion(): CancelCompletionResult {
	if (!isCompletionRunning()) {
		return {
			ok: false,
			status: 409,
			response: { error: "no_active_completion" },
		};
	}

	const state = getCompletionState();

	// Cancel through the agent interface (which will handle SDK-level cancellation)
	if (currentAgent) {
		currentAgent.cancel(currentSessionId).catch((err) => {
			console.error("Error calling agent.cancel():", err);
		});
	}

	// Also abort the controller as a fallback
	if (currentAbortController) {
		currentAbortController.abort();
		currentAbortController = null;
	}

	console.log(
		JSON.stringify({
			event: "cancelled",
			completionId: state.completionId,
		}),
	);

	return {
		ok: true,
		status: 200,
		response: {
			success: true,
			completionId: state.completionId || "unknown",
			status: "cancelled",
		},
	};
}

/**
 * Configure git user settings globally.
 * Runs git config commands to set user.name and user.email.
 */
async function configureGitUser(
	userName: string | null,
	userEmail: string | null,
): Promise<void> {
	if (userName) {
		await execAsync(`git config --global user.name "${userName}"`);
	}
	if (userEmail) {
		await execAsync(`git config --global user.email "${userEmail}"`);
	}
}

/**
 * Run a completion in the background. This function does not block -
 * it starts the completion and returns immediately. The completion
 * continues running even if the client disconnects.
 */
function runCompletion(
	agent: Agent,
	_completionId: string,
	lastUserMessage: UIMessage,
	credentialsChanged: boolean,
	credentialEnv: Record<string, string>,
	gitUserName: string | null,
	gitUserEmail: string | null,
	log: (data: Record<string, unknown>) => void,
	sessionId: string | undefined,
	abortSignal: AbortSignal,
): void {
	// Run asynchronously without blocking the caller
	(async () => {
		// Clear any stale events from previous completions
		clearCompletionEvents();

		try {
			// Check if already cancelled before starting
			if (abortSignal.aborted) {
				throw new Error("Completion cancelled before start");
			}

			// Configure git user settings if provided
			if (gitUserName || gitUserEmail) {
				await configureGitUser(gitUserName, gitUserEmail);
			}

			// If credentials changed, update environment
			if (credentialsChanged) {
				await agent.updateEnvironment({ env: credentialEnv });
			}

			// Ensure connected and session exists BEFORE adding messages
			// (ensureSession may clear messages when creating a new session)
			if (!agent.isConnected) {
				await agent.connect();
			}
			await agent.ensureSession(sessionId);

			// Get the session
			const session = agent.getSession(sessionId);
			if (!session) {
				throw new Error("Failed to get or create session");
			}

			// Use the incoming UIMessage directly, ensuring it has an ID
			const userMessage: UIMessage = {
				...lastUserMessage,
				id: lastUserMessage.id || generateMessageId(),
			};

			// Stream chunks from the agent's prompt generator with cancellation checking
			// The SDK emits start (via message_start) and finish (via result) events
			for await (const chunk of agent.prompt(userMessage, sessionId)) {
				// Check if cancelled during iteration
				if (abortSignal.aborted) {
					// Send finish event with stop reason instead of error
					addCompletionEvent({
						type: "finish",
						finishReason: "stop",
					});
					log({ event: "cancelled" });
					await finishCompletion();
					return;
				}

				addCompletionEvent(chunk);
			}

			log({ event: "completed" });
			await finishCompletion();
		} catch (error) {
			// Check if this was an abort error
			if (
				error instanceof Error &&
				(error.name === "AbortError" || error.message.includes("cancelled"))
			) {
				// Send finish event with stop reason for cancellation
				addCompletionEvent({
					type: "finish",
					finishReason: "stop",
				});
				log({ event: "cancelled" });
				await finishCompletion();
				return;
			}

			const errorText = extractErrorMessage(error);
			log({ event: "error", error: errorText });
			// Send error event to SSE stream so the client receives it
			addCompletionEvent({ type: "error", errorText });
			// Also send finish event with error reason for proper completion
			addCompletionEvent({
				type: "finish",
				finishReason: "error",
			});
			await finishCompletion(errorText);
		} finally {
			currentAgent = null;
			currentSessionId = undefined;
			currentAbortController = null;
		}
	})();
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
