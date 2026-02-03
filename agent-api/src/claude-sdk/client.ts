import { access, constants } from "node:fs/promises";
import {
	type Options,
	query,
	type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { UIMessage } from "ai";
import { SessionImpl } from "../acp/session-impl.js";
import type {
	Agent,
	AgentUpdateCallback,
	EnvironmentUpdate,
} from "../agent/interface.js";
import type { Session } from "../agent/session.js";
import type { StreamBlockIds, StreamState } from "../server/stream.js";
import { createBlockIds, createStreamState } from "../server/stream.js";
import {
	clearSession as clearStoredSession,
	getSessionData,
	loadSession,
	type SessionData as StoreSessionData,
	saveSession,
} from "../store/session.js";
import {
	type ClaudeSessionInfo,
	discoverSessions,
	loadFullSessionData,
	loadSessionMessages,
	type SessionData,
} from "./persistence.js";
import { sdkMessageToChunks } from "./translate.js";

interface SessionContext {
	sessionId: string;
	claudeSessionId: string | null;
	session: SessionImpl;
	callback: AgentUpdateCallback | null;
	streamState: StreamState | null;
	blockIds: StreamBlockIds | null;
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
			ctx = {
				sessionId: sid,
				claudeSessionId: null,
				session: new SessionImpl(sid),
				callback: null,
				streamState: null,
				blockIds: null,
			};
			this.sessions.set(sid, ctx);

			// Always try to load existing session from ~/.claude
			await this.loadSessionFromDisk(ctx);
		}

		this.currentSessionId = sid;
		return sid;
	}

	/**
	 * Load a session from disk, including the persisted claudeSessionId mapping
	 */
	private async loadSessionFromDisk(ctx: SessionContext): Promise<void> {
		try {
			// First, try to load the persisted session data which includes claudeSessionId
			const storedSession = await loadSession();
			if (storedSession && storedSession.sessionId === ctx.sessionId) {
				// Restore the Claude session ID mapping
				if (storedSession.claudeSessionId) {
					ctx.claudeSessionId = storedSession.claudeSessionId;
					console.log(
						`Restored claudeSessionId mapping: ${ctx.sessionId} -> ${ctx.claudeSessionId}`,
					);
				}
			}

			// If we have a claudeSessionId, try to load messages from the Claude session file
			const claudeId = ctx.claudeSessionId;
			if (claudeId) {
				const messages = await loadSessionMessages(claudeId, this.options.cwd);

				// Add messages to the session
				for (const msg of messages) {
					ctx.session.addMessage(msg);
				}

				console.log(
					`Loaded ${messages.length} messages from Claude session ${claudeId}`,
				);
			}
		} catch (error) {
			console.warn(`Failed to load session from disk:`, error);
		}
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

	async prompt(message: UIMessage, sessionId?: string): Promise<void> {
		const sid = await this.ensureSession(sessionId);
		const ctx = this.sessions.get(sid)!;

		// Initialize stream state for this prompt
		ctx.streamState = createStreamState();
		ctx.blockIds = createBlockIds(message.id);

		// Add user message to session
		ctx.session.addMessage(message);

		// Create assistant message placeholder
		const assistantMessage = {
			id: `assistant-${Date.now()}`,
			role: "assistant" as const,
			parts: [],
		};
		ctx.session.addMessage(assistantMessage);

		// Extract text from message
		const promptText = this.messageToPrompt(message);

		// Configure SDK options
		const sdkOptions: Options = {
			cwd: this.options.cwd,
			model: this.options.model,
			resume: ctx.claudeSessionId || undefined,
			env: this.env,
			includePartialMessages: true,
			tools: { type: "preset", preset: "claude_code" },
			systemPrompt: { type: "preset", preset: "claude_code" },
			settingSources: ["project"], // Load CLAUDE.md files
			maxThinkingTokens: 10000, // Enable extended thinking with reasonable token limit
			// Use the discovered Claude CLI path from connect()
			pathToClaudeCodeExecutable: this.claudeCliPath!,
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
			// Use hooks to capture tool output after execution
			hooks: {
				PostToolUse: [
					{
						hooks: [
							async (input: any, toolUseID: string | undefined) => {
								console.log(
									`[SDK] PostToolUse hook: ${(input as any).tool_name}`,
									`tool_use_id: ${toolUseID}`,
									`response: ${JSON.stringify((input as any).tool_response).substring(0, 200)}...`,
								);

								// Emit tool-output-available chunk via the session callback
								if (ctx.callback && toolUseID) {
									ctx.callback({
										type: "tool-output-available",
										toolCallId: toolUseID,
										output: (input as any).tool_response,
										dynamic: true,
									});
								}

								return {};
							},
						],
					},
				],
			},
		};

		try {
			// Start query
			const q = query({ prompt: promptText, options: sdkOptions });

			// Stream messages
			for await (const sdkMsg of q) {
				await this.handleSDKMessage(ctx, sdkMsg, assistantMessage.id);
			}
		} catch (error) {
			console.error("SDK query error:", error);
			throw error;
		}
	}

	async cancel(_sessionId?: string): Promise<void> {
		// SDK query is async generator, cancellation happens when we stop iterating
		// For now, we don't have active queries to cancel
	}

	setUpdateCallback(
		callback: AgentUpdateCallback | null,
		sessionId?: string,
	): void {
		const sid = sessionId || this.currentSessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(sid);
		if (ctx) {
			ctx.callback = callback;
		}
	}

	async clearSession(sessionId?: string): Promise<void> {
		const sid = sessionId || this.currentSessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(sid);
		if (ctx) {
			ctx.session.clearMessages();
			ctx.claudeSessionId = null;
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

	createSession(sessionId: string): Session {
		const ctx: SessionContext = {
			sessionId,
			claudeSessionId: null,
			session: new SessionImpl(sessionId),
			callback: null,
			streamState: null,
			blockIds: null,
		};
		this.sessions.set(sessionId, ctx);
		return ctx.session;
	}

	async updateEnvironment(update: EnvironmentUpdate): Promise<void> {
		Object.assign(this.env, update.env);
	}

	getEnvironment(): Record<string, string> {
		return { ...this.env };
	}

	// Convenience methods for default session
	getMessages(): UIMessage[] {
		return this.getSession()?.getMessages() ?? [];
	}

	addMessage(message: UIMessage): void {
		this.getSession()?.addMessage(message);
	}

	updateMessage(id: string, updates: Partial<UIMessage>): void {
		this.getSession()?.updateMessage(id, updates);
	}

	getLastAssistantMessage(): UIMessage | undefined {
		return this.getSession()?.getLastAssistantMessage();
	}

	clearMessages(): void {
		this.getSession()?.clearMessages();
	}

	// Private helper methods
	private messageToPrompt(message: UIMessage): string {
		const textParts = message.parts
			.filter((p) => p.type === "text")
			.map((p) => (p as any).text);
		return textParts.join("\n");
	}

	private async handleSDKMessage(
		ctx: SessionContext,
		msg: SDKMessage,
		assistantMessageId: string,
	): Promise<void> {
		// Capture session ID from init message and persist the mapping
		if (msg.type === "system" && msg.subtype === "init") {
			ctx.claudeSessionId = msg.session_id;
			// Persist the mapping so it survives restarts
			await this.persistClaudeSessionId(ctx.sessionId, msg.session_id);
			return;
		}

		// Translate SDK message to UIMessageChunks and emit
		if (ctx.streamState && ctx.blockIds) {
			const chunks = sdkMessageToChunks(msg, ctx.streamState, ctx.blockIds);
			console.log(
				`[CLIENT] Got ${chunks.length} chunks from translate, callback=${!!ctx.callback}`,
			);
			for (const chunk of chunks) {
				if (ctx.callback) {
					console.log(`[CLIENT] Emitting chunk: ${chunk.type}`);
					ctx.callback(chunk);
				}
			}
		} else {
			console.log(
				`[CLIENT] Skipping chunks - streamState=${!!ctx.streamState}, blockIds=${!!ctx.blockIds}`,
			);
		}

		// Update session message store
		await this.updateMessageFromSDK(ctx, msg, assistantMessageId);
	}

	private async updateMessageFromSDK(
		ctx: SessionContext,
		msg: SDKMessage,
		_assistantMessageId: string,
	): Promise<void> {
		// Debug: log message types
		console.log(`[CLIENT updateMessageFromSDK] msg.type=${msg.type}`);

		if (msg.type === "result") {
			console.log(
				`[CLIENT] Result message:`,
				JSON.stringify(msg, null, 2).substring(0, 1000),
			);
		}

		// Update the assistant message with content from SDK
		if (msg.type === "assistant") {
			const assistantMsg = ctx.session.getLastAssistantMessage();
			if (!assistantMsg) return;

			// Extract text, thinking, tool content, and tool results from the message
			const content = msg.message.content;
			console.log(`[CLIENT] Assistant message has ${content.length} blocks`);
			for (const block of content) {
				console.log(`[CLIENT] Block type: ${block.type}`);
				if (block.type === "text") {
					// Append text to the last part if it's text, otherwise create new part
					const lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];
					if (lastPart && lastPart.type === "text") {
						(lastPart as any).text += block.text;
					} else {
						assistantMsg.parts.push({
							type: "text",
							text: block.text,
						});
					}
				} else if (block.type === "thinking") {
					// Extended thinking/reasoning block
					const thinkingBlock = block as any;
					assistantMsg.parts.push({
						type: "reasoning",
						text: thinkingBlock.thinking,
					});
				} else if (block.type === "tool_use") {
					// Add tool use block
					assistantMsg.parts.push({
						type: "dynamic-tool",
						toolCallId: block.id,
						toolName: block.name,
						state: "input-available",
						input: block.input,
					});
				} else if (block.type === "tool_result") {
					// Tool result - find the corresponding tool_use part and update it
					const toolResult = block as any;
					const toolCallId = toolResult.tool_use_id;

					console.log(
						`[SDK] Received tool result for ${toolCallId}:`,
						JSON.stringify(toolResult).substring(0, 200),
					);

					// Find the tool part and update it with output
					const toolPart = assistantMsg.parts.find(
						(p) =>
							p.type === "dynamic-tool" && (p as any).toolCallId === toolCallId,
					);

					if (toolPart) {
						const tool = toolPart as any;
						tool.state = toolResult.is_error
							? "output-error"
							: "output-available";
						tool.output = toolResult.content;
					} else {
						console.warn(
							`[SDK] Tool result received but no matching tool_use part found for ${toolCallId}`,
						);
					}
				}
			}

			ctx.session.updateMessage(assistantMsg.id, { parts: assistantMsg.parts });
		}

		// Handle stream events for incremental updates
		if (msg.type === "stream_event") {
			const event = msg.event;

			if (event.type === "content_block_delta") {
				const assistantMsg = ctx.session.getLastAssistantMessage();
				if (!assistantMsg) return;

				if (event.delta?.type === "text_delta") {
					// Accumulate text
					const lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];
					if (lastPart && lastPart.type === "text") {
						(lastPart as any).text += event.delta.text;
					} else {
						assistantMsg.parts.push({
							type: "text",
							text: event.delta.text,
						});
					}
					ctx.session.updateMessage(assistantMsg.id, {
						parts: assistantMsg.parts,
					});
				} else if (event.delta?.type === "thinking_delta") {
					// Accumulate extended thinking/reasoning
					const lastPart = assistantMsg.parts[assistantMsg.parts.length - 1];
					if (lastPart && lastPart.type === "reasoning") {
						(lastPart as any).text += event.delta.thinking;
					} else {
						assistantMsg.parts.push({
							type: "reasoning",
							text: event.delta.thinking,
						});
					}
					ctx.session.updateMessage(assistantMsg.id, {
						parts: assistantMsg.parts,
					});
				}
			}
		}
	}
}
