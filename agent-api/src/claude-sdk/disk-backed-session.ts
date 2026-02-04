/**
 * Disk-backed Session implementation for Claude SDK.
 *
 * Reads messages from ~/.claude/projects on load() and caches them.
 * Claude SDK handles all persistence - we just read what's on disk.
 *
 * Design:
 * - Call load() to read messages from disk into cache
 * - getMessages() returns the cached snapshot
 * - Call load() again at start of each turn to refresh from disk
 */

import type { UIMessage } from "ai";
import type { Session } from "../agent/session.js";
import { loadSessionMessages } from "./persistence.js";

export class DiskBackedSession implements Session {
	private cachedMessages: UIMessage[] = [];
	private claudeSessionId: string | null = null;

	constructor(
		public readonly id: string,
		private cwd: string,
	) {}

	/**
	 * Load messages from disk into the cache.
	 *
	 * @param claudeSessionId - The Claude CLI session ID to load from.
	 *   This may differ from this.id (the discobot session ID).
	 */
	async load(claudeSessionId?: string): Promise<void> {
		const sessionIdToLoad = claudeSessionId ?? this.claudeSessionId ?? this.id;
		if (claudeSessionId) {
			this.claudeSessionId = claudeSessionId;
		}
		this.cachedMessages = await loadSessionMessages(sessionIdToLoad, this.cwd);
	}

	/**
	 * Get all messages (returns cached snapshot from last load).
	 */
	getMessages(): UIMessage[] {
		return this.cachedMessages;
	}

	/**
	 * Clear cached messages.
	 * Note: This only clears the local cache, not the Claude CLI session file.
	 */
	clearMessages(): void {
		this.cachedMessages = [];
		this.claudeSessionId = null;
	}

	/**
	 * Set the Claude session ID for loading.
	 * Call this before load() when the Claude CLI session ID differs from discobot session ID.
	 */
	setClaudeSessionId(claudeSessionId: string): void {
		this.claudeSessionId = claudeSessionId;
	}
}
