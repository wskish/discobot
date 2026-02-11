import type { UIMessage } from "ai";
import type { Session } from "../agent/session.js";
import { loadSessionMessages } from "./persistence.js";

/**
 * Disk-backed Session implementation for Claude SDK.
 *
 * Reads messages from ~/.claude/projects on demand and caches them in memory.
 * During streaming, updates are buffered in a dirty map to avoid disk I/O.
 * The Claude SDK handles actual persistence - we just read and cache.
 *
 * Design:
 * - Lazy loading: Messages loaded from disk on first load() call
 * - Smart caching: Cached messages reused for subsequent getMessages() calls
 * - Dirty map: Streaming updates buffered in memory (no disk I/O during hot path)
 * - Cache invalidation: Clear cache at start of each turn to reload from disk
 */
export class DiskBackedSession implements Session {
	private cachedMessages: UIMessage[] | null = null;
	private dirtyMessages = new Map<string, UIMessage>();
	private cwd: string;

	constructor(
		public readonly id: string,
		cwd: string,
	) {
		this.cwd = cwd;
	}

	/**
	 * Load messages from disk. Call this after construction to initialize.
	 * If the session file doesn't exist, cachedMessages will be an empty array.
	 */
	async load(): Promise<void> {
		if (this.cachedMessages === null) {
			this.cachedMessages = await loadSessionMessages(this.id, this.cwd);
		}
	}

	/**
	 * Get all messages, merging cached messages with dirty updates.
	 * Returns cached messages merged with any streaming updates.
	 */
	getMessages(): UIMessage[] {
		if (this.cachedMessages === null) {
			console.warn(
				`[DiskBackedSession] getMessages called before load() on session ${this.id}`,
			);
			return [];
		}

		return this.mergeMessages();
	}

	/**
	 * Merge cached messages with dirty updates.
	 * Dirty messages take precedence (replace by ID, or append if new).
	 */
	private mergeMessages(): UIMessage[] {
		if (this.cachedMessages === null) {
			return [];
		}

		// Start with a copy of cached messages
		const result = [...this.cachedMessages];

		// Apply dirty updates
		for (const [id, dirtyMsg] of this.dirtyMessages) {
			const index = result.findIndex((m) => m.id === id);
			if (index !== -1) {
				// Replace existing message
				result[index] = dirtyMsg;
			} else {
				// Append new message
				result.push(dirtyMsg);
			}
		}

		return result;
	}

	/**
	 * Add a message. Goes to dirty map (no disk I/O).
	 */
	addMessage(message: UIMessage): void {
		this.dirtyMessages.set(message.id, message);
	}

	/**
	 * Update an existing message by ID. Updates in dirty map (no disk I/O).
	 */
	updateMessage(id: string, updates: Partial<UIMessage>): void {
		// Get current version (from dirty or cache)
		let current = this.dirtyMessages.get(id);
		if (!current && this.cachedMessages) {
			current = this.cachedMessages.find((m) => m.id === id);
		}

		if (current) {
			// Merge updates and store in dirty map
			this.dirtyMessages.set(id, { ...current, ...updates });
		} else {
			console.warn(
				`[DiskBackedSession] updateMessage called for unknown message ID: ${id}`,
			);
		}
	}

	/**
	 * Get the last assistant message (for updating during streaming).
	 */
	getLastAssistantMessage(): UIMessage | undefined {
		const messages = this.mergeMessages();
		// Search backwards for the last assistant message
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "assistant") {
				return messages[i];
			}
		}
		return undefined;
	}

	/**
	 * Clear all messages (both cache and dirty).
	 */
	clearMessages(): void {
		this.cachedMessages = [];
		this.dirtyMessages.clear();
	}

	/**
	 * Invalidate cache - next load() will reload from disk.
	 * Call this at the start of a new turn after SDK persists.
	 */
	invalidateCache(): void {
		this.cachedMessages = null;
	}

	/**
	 * Clear dirty updates from streaming.
	 * Call this at the start of a new turn.
	 */
	clearDirty(): void {
		this.dirtyMessages.clear();
	}
}
