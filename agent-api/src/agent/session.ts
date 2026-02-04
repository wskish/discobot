import type { UIMessage } from "ai";

/**
 * Session interface - represents an individual chat session with its own message history.
 *
 * Each session is independent and maintains its own state. The agent manages multiple
 * sessions and can switch between them.
 *
 * Messages are read from Claude SDK's JSONL files on disk.
 */
export interface Session {
	/**
	 * Unique session identifier.
	 */
	readonly id: string;

	/**
	 * Get all messages in this session.
	 * Messages are loaded from Claude SDK's session files.
	 */
	getMessages(): UIMessage[];

	/**
	 * Clear the cached messages in this session.
	 */
	clearMessages(): void;
}
