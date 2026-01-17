import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { UIMessage } from "ai";

// TODO: Move these to a proper data directory (e.g., ~/.octobot/ or XDG_DATA_HOME)
const SESSION_FILE = process.env.SESSION_FILE || "/tmp/agent-session.json";
const MESSAGES_FILE = process.env.MESSAGES_FILE || "/tmp/agent-messages.json";

export interface SessionData {
	sessionId: string;
	cwd: string;
	createdAt: string;
}

// In-memory message store using AI SDK's UIMessage type
let messages: UIMessage[] = [];
let sessionData: SessionData | null = null;

// Debounce timer for saving messages
let saveMessagesTimer: ReturnType<typeof setTimeout> | null = null;

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

export function finishCompletion(error?: string): void {
	completionState = {
		isRunning: false,
		completionId: completionState.completionId,
		startedAt: completionState.startedAt,
		error: error || null,
	};
}

export function isCompletionRunning(): boolean {
	return completionState.isRunning;
}

export function getMessages(): UIMessage[] {
	return messages;
}

export function addMessage(message: UIMessage): void {
	messages.push(message);
	// Debounce save to avoid too many disk writes
	scheduleSaveMessages();
}

export function updateMessage(id: string, updates: Partial<UIMessage>): void {
	const index = messages.findIndex((m) => m.id === id);
	if (index !== -1) {
		messages[index] = { ...messages[index], ...updates };
		// Debounce save to avoid too many disk writes
		scheduleSaveMessages();
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
	// Clear any pending save
	if (saveMessagesTimer) {
		clearTimeout(saveMessagesTimer);
		saveMessagesTimer = null;
	}
}

function scheduleSaveMessages(): void {
	if (saveMessagesTimer) {
		clearTimeout(saveMessagesTimer);
	}
	saveMessagesTimer = setTimeout(() => {
		saveMessages().catch((err) =>
			console.error("Failed to save messages:", err),
		);
	}, 500);
}

async function saveMessages(): Promise<void> {
	try {
		const dir = dirname(MESSAGES_FILE);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2), "utf-8");
		console.log(`Saved ${messages.length} messages to ${MESSAGES_FILE}`);
	} catch (error) {
		console.error("Failed to save messages:", error);
	}
}

export async function loadMessages(): Promise<UIMessage[]> {
	try {
		if (!existsSync(MESSAGES_FILE)) {
			return [];
		}
		const content = await readFile(MESSAGES_FILE, "utf-8");
		messages = JSON.parse(content) as UIMessage[];
		console.log(`Loaded ${messages.length} messages from ${MESSAGES_FILE}`);
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
		if (!existsSync(SESSION_FILE)) {
			return null;
		}
		const content = await readFile(SESSION_FILE, "utf-8");
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
		const dir = dirname(SESSION_FILE);
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(SESSION_FILE, JSON.stringify(data, null, 2), "utf-8");
		sessionData = data;
		console.log(`Session saved to ${SESSION_FILE}`);
	} catch (error) {
		console.error("Failed to save session:", error);
		throw error;
	}
}

export async function clearSession(): Promise<void> {
	try {
		if (existsSync(SESSION_FILE)) {
			await unlink(SESSION_FILE);
		}
		if (existsSync(MESSAGES_FILE)) {
			await unlink(MESSAGES_FILE);
		}
		console.log("Session cleared");
		sessionData = null;
		messages = [];
	} catch (error) {
		console.error("Failed to clear session:", error);
	}
}
