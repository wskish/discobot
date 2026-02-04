import type { UIMessage, UIMessageChunk } from "ai";
import type { Session } from "./session.js";

/**
 * Agent interface - abstracts the underlying agent implementation.
 *
 * This interface uses AI SDK types (UIMessage, UIMessageChunk) to remain
 * implementation-agnostic. Different implementations handle their own
 * protocol translation and message storage internally.
 *
 * The agent is multi-session aware and can manage multiple independent sessions.
 */
export interface Agent {
	/**
	 * Connect to the agent and establish a session.
	 */
	connect(): Promise<void>;

	/**
	 * Ensure a session exists. Creates or resumes a session as needed.
	 * Returns the session ID.
	 * @param sessionId - Optional session ID to ensure. If not provided, uses default session.
	 */
	ensureSession(sessionId?: string): Promise<string>;

	/**
	 * Send a prompt to the agent and stream UIMessageChunk events.
	 * Returns an async generator that yields chunks as they arrive.
	 * @param message - The user message to send
	 * @param sessionId - Optional session ID to send prompt to. If not provided, uses default session.
	 */
	prompt(
		message: UIMessage,
		sessionId?: string,
	): AsyncGenerator<UIMessageChunk, void, unknown>;

	/**
	 * Cancel the current operation.
	 * @param sessionId - Optional session ID to cancel. If not provided, uses default session.
	 */
	cancel(sessionId?: string): Promise<void>;

	/**
	 * Disconnect from the agent and clean up resources.
	 */
	disconnect(): Promise<void>;

	/**
	 * Check if the agent is currently connected.
	 */
	get isConnected(): boolean;

	/**
	 * Update environment variables and restart the agent if connected.
	 */
	updateEnvironment(update: EnvironmentUpdate): Promise<void>;

	/**
	 * Get current environment variables.
	 */
	getEnvironment(): Record<string, string>;

	// Session management methods
	/**
	 * Get a session by ID. Returns undefined if session doesn't exist.
	 * If no sessionId is provided, returns the default session.
	 */
	getSession(sessionId?: string): Session | undefined;

	/**
	 * List all session IDs.
	 */
	listSessions(): string[];

	/**
	 * Create a new session with the given ID.
	 * @throws Error if session already exists
	 */
	createSession(sessionId: string): Session;

	/**
	 * Clear a specific session (messages and session state).
	 * If no sessionId is provided, clears the default session.
	 */
	clearSession(sessionId?: string): Promise<void>;
}

export interface EnvironmentUpdate {
	env: Record<string, string>;
}
