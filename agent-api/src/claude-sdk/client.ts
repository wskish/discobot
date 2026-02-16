import { access, constants } from "node:fs/promises";
import {
	type Options,
	query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UIMessage, UIMessageChunk } from "ai";
import type { Agent } from "../agent/interface.js";
import type { Session } from "../agent/session.js";
import {
	clearSession as clearStoredSession,
	getSessionData,
	type SessionData as StoreSessionData,
	saveSession,
} from "../store/session.js";
import { messageToContentBlocks } from "./content-blocks.js";
import { DiskBackedSession } from "./disk-backed-session.js";
import {
	type ClaudeSessionInfo,
	discoverSessions,
	getLastMessageError,
	loadFullSessionData,
	type SessionData,
} from "./persistence.js";
import {
	createTranslationState,
	type TranslationState,
	translateSDKMessage,
} from "./translate.js";

interface SessionContext {
	sessionId: string;
	claudeSessionId: string | null;
	session: Session;
	translationState: TranslationState | null;
}

export interface ClaudeSDKClientOptions {
	cwd: string;
	model?: string;
	env?: Record<string, string>;
}

/**
 * Find the Claude CLI binary on PATH or common installation locations
 */
async function findClaudeCLI(): Promise<string | null> {
	// First check environment variable override
	if (process.env.CLAUDE_CLI_PATH) {
		console.log(`[SDK] Using CLAUDE_CLI_PATH: ${process.env.CLAUDE_CLI_PATH}`);
		return process.env.CLAUDE_CLI_PATH;
	}

	// Build list of paths to check (PATH + common locations)
	const pathsToCheck: string[] = [];

	// Add directories from PATH environment variable
	if (process.env.PATH) {
		const pathDirs = process.env.PATH.split(":");
		for (const dir of pathDirs) {
			if (dir) {
				pathsToCheck.push(`${dir}/claude`);
			}
		}
	}

	// Add common installation locations as fallback
	const commonPaths = [
		process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : null,
		"/usr/bin/claude",
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
	].filter(Boolean) as string[];

	// Add common paths if not already in pathsToCheck
	for (const commonPath of commonPaths) {
		if (!pathsToCheck.includes(commonPath)) {
			pathsToCheck.push(commonPath);
		}
	}

	// Try each path in order
	for (const path of pathsToCheck) {
		try {
			// Check if file exists and is executable
			await access(path, constants.X_OK);
			console.log(`[SDK] Found Claude CLI at: ${path}`);
			return path;
		} catch {
			// Not found or not executable at this path, try next
		}
	}

	console.warn(
		"[SDK] Could not find Claude CLI. Set CLAUDE_CLI_PATH environment variable or ensure 'claude' is on PATH.",
	);
	console.warn(`[SDK] Searched ${pathsToCheck.length} locations`);
	console.warn(`[SDK] Current PATH: ${process.env.PATH}`);
	console.warn(`[SDK] Current HOME: ${process.env.HOME}`);
	return null;
}

export class ClaudeSDKClient implements Agent {
	private DEFAULT_SESSION_ID = "default";
	private sessions = new Map<string, SessionContext>();
	private currentSessionId: string | null = null;
	private env: Record<string, string>;
	private claudeCliPath: string | null = null;
	private connected = false;
	private activeAbortController: AbortController | null = null;

	constructor(private options: ClaudeSDKClientOptions) {
		console.log("ClaudeSDKClient constructor", options);
		this.env = { ...options.env };
	}

	async connect(): Promise<void> {
		// Find Claude CLI binary on PATH
		this.claudeCliPath = await findClaudeCLI();
		if (!this.claudeCliPath) {
			throw new Error(
				"Claude CLI not found. Install it or set CLAUDE_CLI_PATH environment variable.",
			);
		}
		this.connected = true;
	}

	async disconnect(): Promise<void> {
		// Clean up any active sessions
		this.sessions.clear();
		this.connected = false;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	async ensureSession(sessionId?: string): Promise<string> {
		const sid = sessionId || this.DEFAULT_SESSION_ID;
		let ctx = this.sessions.get(sid);

		if (!ctx) {
			// If looking up the default session and it doesn't exist,
			// check if there's exactly one Claude CLI session available and use it
			if (sid === this.DEFAULT_SESSION_ID) {
				const availableSessions = await this.discoverAvailableSessions();
				if (availableSessions.length === 1) {
					const existingSessionId = availableSessions[0].sessionId;
					console.log(
						`[SDK] Default session not found, using existing Claude session: ${existingSessionId}`,
					);

					// Create a DiskBackedSession using the discovered Claude session ID
					// Since this is a Claude CLI session, the sessionId and claudeSessionId are the same
					const session = new DiskBackedSession(
						existingSessionId,
						this.options.cwd,
					);

					ctx = {
						sessionId: existingSessionId,
						claudeSessionId: existingSessionId, // Same as sessionId for discovered sessions
						session,
						translationState: null,
					};
					this.sessions.set(existingSessionId, ctx);

					// Load messages from the Claude CLI session file
					if (session instanceof DiskBackedSession) {
						await session.load(existingSessionId);
						console.log(
							`[SDK] Loaded messages from Claude session: ${existingSessionId}`,
						);
					}

					this.currentSessionId = existingSessionId;
					return existingSessionId;
				}
			}

			// Create DiskBackedSession - don't call load() here since the discobot session ID
			// won't match the Claude CLI's session ID. loadSessionFromDisk will handle loading
			// messages using the correct claudeSessionId mapping.
			const session = new DiskBackedSession(sid, this.options.cwd);

			ctx = {
				sessionId: sid,
				claudeSessionId: null,
				session,
				translationState: null,
			};
			this.sessions.set(sid, ctx);

			// Load persisted claudeSessionId mapping and messages from disk
			// This restores the session state after agent-api restart
			await this.loadSessionFromDisk(ctx);
		}

		this.currentSessionId = sid;
		return sid;
	}

	/**
	 * Persist the mapping between discobot sessionId and Claude SDK sessionId
	 */
	private async persistClaudeSessionId(
		sessionId: string,
		claudeSessionId: string,
	): Promise<void> {
		try {
			const existingSession = getSessionData();
			const sessionData: StoreSessionData = {
				sessionId,
				cwd: this.options.cwd,
				createdAt: existingSession?.createdAt || new Date().toISOString(),
				claudeSessionId,
			};
			await saveSession(sessionData);
			console.log(
				`Persisted claudeSessionId mapping: ${sessionId} -> ${claudeSessionId}`,
			);
		} catch (error) {
			console.error(`Failed to persist claudeSessionId mapping:`, error);
		}
	}

	/**
	 * Discover all available sessions from ~/.claude
	 */
	async discoverAvailableSessions(): Promise<ClaudeSessionInfo[]> {
		return discoverSessions(this.options.cwd);
	}

	/**
	 * Load full session data including progress records and metadata
	 */
	async loadFullSession(sessionId: string): Promise<SessionData | null> {
		return loadFullSessionData(sessionId, this.options.cwd);
	}

	async *prompt(
		message: UIMessage,
		sessionId?: string,
	): AsyncGenerator<UIMessageChunk, void, unknown> {
		const sid = await this.ensureSession(sessionId);
		const ctx = this.sessions.get(sid);
		if (!ctx) {
			throw new Error(`Session ${sid} not found`);
		}

		// Reload messages from disk at start of each turn
		if (ctx.session instanceof DiskBackedSession && ctx.claudeSessionId) {
			await ctx.session.load(ctx.claudeSessionId);
		}

		// Initialize translation state for this prompt (will be set properly on message_start)
		ctx.translationState = null;

		// Convert message parts to Claude SDK content blocks format
		// This includes text and image attachments
		const contentBlocks = messageToContentBlocks(message);

		// Create abort controller for this prompt
		this.activeAbortController = new AbortController();

		// Configure SDK options
		const sdkOptions: Options = {
			cwd: this.options.cwd,
			model: this.options.model,
			resume: ctx.claudeSessionId || undefined,
			env: this.env,
			includePartialMessages: true,
			tools: { type: "preset", preset: "claude_code" },
			systemPrompt: { type: "preset", preset: "claude_code" },
			settingSources: ["user", "project"], // Load user settings from ~/.claude and CLAUDE.md files
			maxThinkingTokens: 10000, // Enable extended thinking with reasonable token limit
			// Use the discovered Claude CLI path from connect()
			pathToClaudeCodeExecutable: this.claudeCliPath ?? "",
			// Pass abort controller to SDK for proper cancellation
			abortController: this.activeAbortController,
			// Use canUseTool to intercept tool calls and auto-approve them
			// This allows us to capture tool I/O while maintaining automatic execution
			canUseTool: async (toolName, input, options) => {
				console.log(
					`[SDK] canUseTool: ${toolName}, toolUseID: ${options.toolUseID}`,
				);
				// Always approve - we just want to intercept for logging
				// Note: updatedInput is required by the SDK's runtime Zod schema even though TypeScript marks it optional
				return {
					behavior: "allow" as const,
					updatedInput: input,
					toolUseID: options.toolUseID,
				};
			},
			// Tool outputs are handled through streaming events (tool_result blocks)
			// rather than PostToolUse hooks to maintain proper event ordering
		};

		// Create async generator for the prompt with content blocks
		// This format supports both text and image attachments
		const promptGenerator = (async function* () {
			yield {
				type: "user" as const,
				message: {
					role: "user" as const,
					content: contentBlocks,
				},
				parent_tool_use_id: null,
				session_id: ctx.claudeSessionId || "",
			};
		})();

		// Helper function to check last message for errors and create error chunks
		const checkLastMessageError = async (): Promise<{
			errorMessage: string | null;
			chunks: UIMessageChunk[];
		}> => {
			if (!ctx.claudeSessionId) {
				return { errorMessage: null, chunks: [] };
			}

			const errorMessage = await getLastMessageError(
				ctx.claudeSessionId,
				this.options.cwd,
			);

			if (!errorMessage) {
				return { errorMessage: null, chunks: [] };
			}

			// Create error chunks
			const chunks: UIMessageChunk[] = [
				{ type: "error", errorText: errorMessage } as UIMessageChunk,
				{ type: "finish", finishReason: "error" } as UIMessageChunk,
			];

			return { errorMessage, chunks };
		};

		// Start query and yield chunks
		const q = query({ prompt: promptGenerator, options: sdkOptions });

		try {
			for await (const sdkMsg of q) {
				const chunks = this.translateSDKMessage(ctx, sdkMsg);
				for (const chunk of chunks) {
					yield chunk;
				}
			}

			// After the query completes successfully, check if Claude process crashed
			// and wrote an error to the messages file (edge case where SDK doesn't throw)
			const { errorMessage, chunks } = await checkLastMessageError();
			if (errorMessage) {
				console.error(`[SDK] Detected error in last message: ${errorMessage}`);
				// Yield error chunks
				for (const chunk of chunks) {
					yield chunk;
				}
				throw new Error(errorMessage);
			}
		} catch (error) {
			// Check if this is a process exit error - if so, try to get the user-friendly
			// error message from the last message on disk instead of the generic exit code
			if (
				error instanceof Error &&
				error.message.includes("process exited with code")
			) {
				console.log(
					`[SDK] Claude process exited, checking last message for user-friendly error...`,
				);

				const { errorMessage, chunks } = await checkLastMessageError();
				if (errorMessage) {
					console.log(`[SDK] Found user-friendly error: ${errorMessage}`);
					// Yield error chunks
					for (const chunk of chunks) {
						yield chunk;
					}
					// Throw the user-friendly error instead of the generic process exit error
					throw new Error(errorMessage);
				}
			}

			// Re-throw the original error if we couldn't find a better message
			throw error;
		} finally {
			this.activeAbortController = null;
			// Reload messages from disk after prompt completes
			// This ensures getMessages() returns the updated conversation
			if (ctx.session instanceof DiskBackedSession && ctx.claudeSessionId) {
				await ctx.session.load(ctx.claudeSessionId);
			}
		}
	}

	async cancel(sessionId?: string): Promise<void> {
		if (this.activeAbortController) {
			console.log("[SDK] Cancelling active prompt via abortController");
			// Abort the SDK query - the SDK will clean up resources properly
			this.activeAbortController.abort();
			this.activeAbortController = null;

			// Clear translation state but keep session ID to preserve history
			const sid = sessionId || this.currentSessionId || this.DEFAULT_SESSION_ID;
			const ctx = this.sessions.get(sid);
			if (ctx) {
				ctx.translationState = null;
			}
		}
	}

	async clearSession(sessionId?: string): Promise<void> {
		const sid = sessionId || this.currentSessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(sid);
		if (ctx) {
			ctx.session.clearMessages();
			ctx.claudeSessionId = null;
			ctx.translationState = null;
		}
		// Also clear persisted session data
		await clearStoredSession();
	}

	getSession(sessionId?: string): Session | undefined {
		const sid = sessionId || this.currentSessionId || this.DEFAULT_SESSION_ID;
		return this.sessions.get(sid)?.session;
	}

	listSessions(): string[] {
		return Array.from(this.sessions.keys());
	}

	createSession(): Session {
		// Generate a unique session ID
		const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

		// Create a new empty session (don't load from disk)
		const session = new DiskBackedSession(sessionId, this.options.cwd);

		const ctx: SessionContext = {
			sessionId,
			claudeSessionId: null,
			session,
			translationState: null,
		};
		this.sessions.set(sessionId, ctx);
		return ctx.session;
	}

	async updateEnvironment(update: Record<string, string>): Promise<void> {
		Object.assign(this.env, update);
	}

	/**
	 * Load persisted session state (claudeSessionId mapping and messages) from disk.
	 * This restores the session state after agent-api restart.
	 */
	private async loadSessionFromDisk(ctx: SessionContext): Promise<void> {
		try {
			// Load persisted session data from disk which contains the claudeSessionId mapping
			// Import loadSession dynamically to get the async disk loading function
			const { loadSession } = await import("../store/session.js");
			const storedSession = await loadSession();
			if (
				storedSession &&
				storedSession.sessionId === ctx.sessionId &&
				storedSession.claudeSessionId
			) {
				ctx.claudeSessionId = storedSession.claudeSessionId;
				console.log(
					`Restored claudeSessionId mapping: ${ctx.sessionId} -> ${ctx.claudeSessionId}`,
				);

				// Load messages from the Claude SDK session JSONL file using the correct claudeSessionId
				if (ctx.session instanceof DiskBackedSession) {
					await ctx.session.load(ctx.claudeSessionId);
					console.log(
						`Restored messages from Claude session ${ctx.claudeSessionId}`,
					);
				}
			}
		} catch (error) {
			console.error(`Failed to load session from disk:`, error);
		}
	}

	getEnvironment(): Record<string, string> {
		return { ...this.env };
	}

	/**
	 * Translate an SDK message to UIMessageChunks.
	 * Also handles session ID capture and translation state management.
	 */
	private translateSDKMessage(
		ctx: SessionContext,
		msg: SDKMessage,
	): UIMessageChunk[] {
		// Capture session ID from init message and persist the mapping
		if (msg.type === "system" && msg.subtype === "init") {
			ctx.claudeSessionId = msg.session_id;
			// Persist the mapping so it survives restarts (fire and forget)
			this.persistClaudeSessionId(ctx.sessionId, msg.session_id);
			return [];
		}

		// Initialize translation state if needed (only once per prompt, not per message)
		// The translate module manages the state across multiple messages in an agentic loop
		if (!ctx.translationState) {
			ctx.translationState = createTranslationState("");
		}

		// Translate SDK message to UIMessageChunks
		const chunks = translateSDKMessage(msg, ctx.translationState);

		// Clean up translation state on result
		if (msg.type === "result") {
			ctx.translationState = null;
		}

		return chunks;
	}
}
