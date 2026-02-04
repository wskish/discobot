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
