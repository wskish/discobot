import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UIMessage, UIMessageChunk } from "ai";

// Use getters to allow tests to override via env vars after module load
function getSessionFile(): string {
	return (
		process.env.SESSION_FILE ||
		"/home/discobot/.config/discobot/agent-session.json"
	);
}

function getMessagesFile(): string {
	return (
		process.env.MESSAGES_FILE ||
		"/home/discobot/.config/discobot/agent-messages.json"
	);
}

export interface SessionData {
	sessionId: string;
	cwd: string;
	createdAt: string;
}

// In-memory message store using AI SDK's UIMessage type
let messages: UIMessage[] = [];
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

export async function finishCompletion(
	error?: string,
	saveMessagesFn?: () => Promise<void>,
): Promise<void> {
	completionState = {
		isRunning: false,
		completionId: completionState.completionId,
		startedAt: completionState.startedAt,
		error: error || null,
	};
	// Note: Events are NOT cleared here - the SSE handler needs to send final
	// events after completion finishes. Events are cleared at the start of
	// the next completion in runCompletion().

	// Only save messages on successful completion
	if (!error && saveMessagesFn) {
		await saveMessagesFn();
	}
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

export function getMessages(): UIMessage[] {
	return messages;
}

export function addMessage(message: UIMessage): void {
	messages.push(message);
}

export function updateMessage(id: string, updates: Partial<UIMessage>): void {
	const index = messages.findIndex((m) => m.id === id);
	if (index !== -1) {
		messages[index] = { ...messages[index], ...updates };
	}
}

export function getLastAssistantMessage(): UIMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			return messages[i];
		}
	}
	return undefined;
}

export function clearMessages(): void {
	messages = [];
}

export async function saveMessages(): Promise<void> {
	try {
		const dir = dirname(getMessagesFile());
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(
			getMessagesFile(),
			JSON.stringify(messages, null, 2),
			"utf-8",
		);
		console.log(`Saved ${messages.length} messages to ${getMessagesFile()}`);
	} catch (error) {
		console.error("Failed to save messages:", error);
	}
}

export async function loadMessages(): Promise<UIMessage[]> {
	try {
		if (!existsSync(getMessagesFile())) {
			return [];
		}
		const content = await readFile(getMessagesFile(), "utf-8");
		messages = JSON.parse(content) as UIMessage[];
		console.log(`Loaded ${messages.length} messages from ${getMessagesFile()}`);
		return messages;
	} catch (error) {
		console.error("Failed to load messages:", error);
		return [];
	}
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
		// Also load messages when loading session
		await loadMessages();
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
		if (existsSync(getMessagesFile())) {
			await unlink(getMessagesFile());
		}
		console.log("Session cleared");
		sessionData = null;
		messages = [];
	} catch (error) {
		console.error("Failed to clear session:", error);
	}
}
