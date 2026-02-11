import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UIMessageChunk } from "ai";

// Use getters to allow tests to override via env vars after module load
function getSessionFile(): string {
	return (
		process.env.SESSION_FILE ||
		`${process.env.HOME}/.config/discobot/agent-session.json`
	);
}

export interface SessionData {
	sessionId: string;
	cwd: string;
	createdAt: string;
	claudeSessionId?: string; // Claude SDK session ID for resumption
}

let sessionData: SessionData | null = null;

// Completion state tracking
export interface CompletionState {
	isRunning: boolean;
	completionId: string | null;
	startedAt: string | null;
	error: string | null;
}

let completionState: CompletionState = {
	isRunning: false,
	completionId: null,
	startedAt: null,
	error: null,
};

export function getCompletionState(): CompletionState {
	return { ...completionState };
}

export function startCompletion(completionId: string): boolean {
	if (completionState.isRunning) {
		return false; // Already running
	}
	completionState = {
		isRunning: true,
		completionId,
		startedAt: new Date().toISOString(),
		error: null,
	};
	return true;
}

export async function finishCompletion(error?: string): Promise<void> {
	completionState = {
		isRunning: false,
		completionId: completionState.completionId,
		startedAt: completionState.startedAt,
		error: error || null,
	};
	// Note: Events are NOT cleared here - the SSE handler needs to send final
	// events after completion finishes. Events are cleared at the start of
	// the next completion in runCompletion().
}

export function isCompletionRunning(): boolean {
	return completionState.isRunning;
}

// Completion events storage for SSE replay
// Events are stored during a completion and cleared when it finishes
let completionEvents: UIMessageChunk[] = [];

export function addCompletionEvent(event: UIMessageChunk): void {
	completionEvents.push(event);
}

export function getCompletionEvents(): UIMessageChunk[] {
	return [...completionEvents];
}

/**
 * Aggregate consecutive delta chunks of the same type/ID into single larger deltas.
 * This dramatically reduces chunk count on replay while keeping protocol intact.
 */
export function aggregateDeltas(chunks: UIMessageChunk[]): UIMessageChunk[] {
	if (chunks.length === 0) return [];

	const result: UIMessageChunk[] = [];
	let i = 0;

	while (i < chunks.length) {
		const chunk = chunks[i];

		// Check if this is a delta chunk that can be aggregated
		if (
			chunk.type === "text-delta" ||
			chunk.type === "reasoning-delta" ||
			chunk.type === "tool-input-delta"
		) {
			// Accumulate consecutive deltas of the same type and ID
			let accumulatedDelta = "";

			while (i < chunks.length) {
				const current = chunks[i];

				// Check if we can aggregate this chunk
				let canAggregate = false;
				if (chunk.type === "text-delta" && current.type === "text-delta") {
					canAggregate = chunk.id === current.id;
					if (canAggregate) accumulatedDelta += current.delta;
				} else if (
					chunk.type === "reasoning-delta" &&
					current.type === "reasoning-delta"
				) {
					canAggregate = chunk.id === current.id;
					if (canAggregate) accumulatedDelta += current.delta;
				} else if (
					chunk.type === "tool-input-delta" &&
					current.type === "tool-input-delta"
				) {
					canAggregate = chunk.toolCallId === current.toolCallId;
					if (canAggregate) accumulatedDelta += current.inputTextDelta;
				}

				if (!canAggregate) break;
				i++;
			}

			// Emit single aggregated delta
			if (chunk.type === "text-delta") {
				result.push({
					type: "text-delta",
					id: chunk.id,
					delta: accumulatedDelta,
				});
			} else if (chunk.type === "reasoning-delta") {
				result.push({
					type: "reasoning-delta",
					id: chunk.id,
					delta: accumulatedDelta,
				});
			} else if (chunk.type === "tool-input-delta") {
				result.push({
					type: "tool-input-delta",
					toolCallId: chunk.toolCallId,
					inputTextDelta: accumulatedDelta,
				});
			}
		} else {
			// Not a delta - pass through as-is
			result.push(chunk);
			i++;
		}
	}

	return result;
}

export function clearCompletionEvents(): void {
	completionEvents = [];
}

/**
 * Clear messages - alias for clearCompletionEvents for test compatibility.
 * Messages are now persisted by the Claude SDK, so this just clears in-memory events.
 */
export function clearMessages(): void {
	clearCompletionEvents();
}

export function getSessionData(): SessionData | null {
	return sessionData;
}

export async function loadSession(): Promise<SessionData | null> {
	try {
		if (!existsSync(getSessionFile())) {
			return null;
		}
		const content = await readFile(getSessionFile(), "utf-8");
		sessionData = JSON.parse(content) as SessionData;
		return sessionData;
	} catch (error) {
		console.error("Failed to load session:", error);
		return null;
	}
}

export async function saveSession(data: SessionData): Promise<void> {
	try {
		const dir = dirname(getSessionFile());
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(getSessionFile(), JSON.stringify(data, null, 2), "utf-8");
		sessionData = data;
		console.log(`Session saved to ${getSessionFile()}`);
	} catch (error) {
		console.error("Failed to save session:", error);
		throw error;
	}
}

export async function clearSession(): Promise<void> {
	try {
		if (existsSync(getSessionFile())) {
			await unlink(getSessionFile());
		}
		console.log("Session cleared");
		sessionData = null;
	} catch (error) {
		console.error("Failed to clear session:", error);
	}
}
