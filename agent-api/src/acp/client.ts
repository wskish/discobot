import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type Agent as ACPAgent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type SessionUpdate,
	type ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { DynamicToolUIPart, UIMessage } from "ai";
import type {
	Agent,
	AgentUpdateCallback,
	EnvironmentUpdate,
} from "../agent/interface.js";
import type { Session } from "../agent/session.js";
import { createUIMessage } from "../agent/utils.js";
import {
	createBlockIds,
	createStreamState,
	extractToolName,
	extractToolOutput,
	type StreamState,
	sessionUpdateToChunks,
} from "../server/stream.js";
import type { SessionData } from "../store/session.js";
import { SessionImpl } from "./session-impl.js";
import { uiMessageToContentBlocks } from "./translate.js";

/** Type alias for UIMessage parts (extracted from UIMessage to avoid generic params) */
type MessagePart = UIMessage["parts"][number];

/**
 * Convert ACP SessionUpdate to UIMessagePart for session replay.
 * Used when reconstructing UIMessages from stored session history.
 */
function sessionUpdateToPart(update: SessionUpdate): MessagePart | null {
	switch (update.sessionUpdate) {
		case "user_message_chunk":
		case "agent_message_chunk":
			if (update.content.type === "text") {
				return { type: "text", text: update.content.text };
			}
			break;

		case "agent_thought_chunk":
			if (update.content.type === "text") {
				return { type: "reasoning", text: update.content.text };
			}
			break;

		case "tool_call":
		case "tool_call_update": {
			const status = update.status;
			let state: DynamicToolUIPart["state"] = "input-streaming";
			if (status === "completed") state = "output-available";
			else if (status === "failed") state = "output-error";
			else if (status === "in_progress") state = "input-available";

			if (state === "output-error") {
				return {
					type: "dynamic-tool",
					toolCallId: update.toolCallId,
					toolName: update.title || "unknown",
					state: "output-error",
					input: update.rawInput || {},
					errorText: String(update.rawOutput || "Tool call failed"),
				};
			}
			if (state === "output-available") {
				return {
					type: "dynamic-tool",
					toolCallId: update.toolCallId,
					toolName: update.title || "unknown",
					state: "output-available",
					input: update.rawInput || {},
					output: update.rawOutput,
				};
			}
			if (state === "input-available") {
				return {
					type: "dynamic-tool",
					toolCallId: update.toolCallId,
					toolName: update.title || "unknown",
					state: "input-available",
					input: update.rawInput || {},
				};
			}
			return {
				type: "dynamic-tool",
				toolCallId: update.toolCallId,
				toolName: update.title || "unknown",
				state: "input-streaming",
				input: update.rawInput,
			};
		}

		case "plan":
			// Convert plan to a synthetic TodoWrite tool call
			return {
				type: "dynamic-tool",
				toolCallId: `plan-${Date.now()}`,
				toolName: "TodoWrite",
				title: "Plan",
				state: "output-available",
				input: {},
				output: update.entries,
			};
	}
	return null;
}

export interface ACPClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	env?: Record<string, string>;
	/**
	 * Enable message persistence to disk.
	 * This is needed for ACP implementations that don't replay messages on session resume
	 * (like Claude Code ACP which uses unstable_resumeSession without message replay).
	 * @default false
	 */
	persistMessages?: boolean;
}

/**
 * SessionContext holds all state for a single session.
 */
interface SessionContext {
	/** The ACP session ID (from newSession/loadSession/unstable_resumeSession) */
	acpSessionId: string | null;
	/** The session implementation with message storage */
	session: SessionImpl;
	/** Update callback for streaming chunks */
	callback: AgentUpdateCallback | null;
	/** Stream state for translating ACP updates to UI chunks */
	streamState: StreamState | null;
	/** Block IDs for the current prompt */
	blockIds: ReturnType<typeof createBlockIds> | null;
	/** Session persistence metadata (if persistence enabled) */
	sessionData: SessionData | null;
}

// Extract method names from ClientSideConnection that take a single param and return a Promise
type ConnectionMethods = {
	[K in keyof ClientSideConnection]: ClientSideConnection[K] extends (
		params: infer _P,
	) => Promise<infer _R>
		? K
		: never;
}[keyof ClientSideConnection];

export class ACPClient implements Agent {
	private connection: ClientSideConnection | null = null;
	private process: ChildProcess | null = null;

	// Multi-session support
	private readonly DEFAULT_SESSION_ID = "default";
	private sessions: Map<string, SessionContext> = new Map();
	private currentSessionId: string | null = null;

	constructor(private options: ACPClientOptions) {}

	/** Execute an ACP request and log request/response as JSON (type-safe) */
	private async request<M extends ConnectionMethods>(
		method: M,
		params: Parameters<ClientSideConnection[M]>[0],
	): Promise<Awaited<ReturnType<ClientSideConnection[M]>>> {
		if (!this.connection) {
			throw new Error("Not connected");
		}
		const fn = this.connection[method].bind(this.connection) as (
			p: typeof params,
		) => Promise<Awaited<ReturnType<ClientSideConnection[M]>>>;
		try {
			const response = await fn(params);
			console.log(JSON.stringify({ acp: method, request: params, response }));
			return response;
		} catch (error) {
			console.log(JSON.stringify({ acp: method, request: params, error }));
			throw error;
		}
	}

	async connect(): Promise<void> {
		const { command, args = [], cwd, env } = this.options;

		// Spawn the agent process
		this.process = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "inherit"],
		});

		if (!this.process.stdin || !this.process.stdout) {
			throw new Error("Failed to create stdio streams");
		}

		// Convert Node.js streams to Web Streams
		const writableStream = Writable.toWeb(
			this.process.stdin,
		) as WritableStream<Uint8Array>;
		const readableStream = Readable.toWeb(
			this.process.stdout,
		) as ReadableStream<Uint8Array>;

		// Create the ACP stream
		const stream = ndJsonStream(writableStream, readableStream);

		// Create the client handler
		const createClient = (_agent: ACPAgent): Client => ({
			requestPermission: async (
				params: RequestPermissionRequest,
			): Promise<RequestPermissionResponse> => {
				// Auto-approve all permissions for now
				// In production, this should present options to the user
				const allowOption = params.options.find((o) => o.kind === "allow_once");
				return {
					outcome: {
						outcome: "selected",
						optionId: allowOption?.optionId || params.options[0].optionId,
					},
				};
			},
			sessionUpdate: async (params: SessionNotification): Promise<void> => {
				const update = params.update;

				// Get the current session context (the active session receiving updates)
				if (!this.currentSessionId) return;
				const ctx = this.sessions.get(this.currentSessionId);
				if (!ctx) return;

				// Update the session's message store from ACP updates
				this.updateMessageFromACP(ctx, update);

				// Translate ACP SessionUpdate to UIMessageChunk and forward to callback
				if (ctx.callback && ctx.streamState && ctx.blockIds) {
					const chunks = sessionUpdateToChunks(
						update,
						ctx.streamState,
						ctx.blockIds,
					);
					for (const chunk of chunks) {
						ctx.callback(chunk);
					}
				}
			},
		});

		// Create the connection
		this.connection = new ClientSideConnection(createClient, stream);

		// Initialize the connection
		await this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: "agent-service", version: "1.0.0" },
			clientCapabilities: {},
		});
	}

	async ensureSession(sessionId?: string): Promise<string> {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		let ctx = this.sessions.get(resolvedSessionId);

		// If session context doesn't exist, create it
		if (!ctx) {
			ctx = {
				acpSessionId: null,
				session: new SessionImpl(resolvedSessionId),
				callback: null,
				streamState: null,
				blockIds: null,
				sessionData: null,
			};
			this.sessions.set(resolvedSessionId, ctx);
		}

		// If already has ACP session ID, just return it
		if (ctx.acpSessionId) {
			this.currentSessionId = resolvedSessionId;
			return ctx.acpSessionId;
		}

		// Otherwise, need to create/load ACP session
		this.currentSessionId = resolvedSessionId;

		// Try to load existing session only if persistence is enabled
		if (this.options.persistMessages) {
			ctx.sessionData = await this.loadSessionData(resolvedSessionId);
			if (ctx.sessionData) {
				// Load messages
				const messages = await this.loadSessionMessages(resolvedSessionId);
				for (const msg of messages) {
					ctx.session.addMessage(msg);
				}
			}
		}

		if (ctx.sessionData && this.connection) {
			// First try unstable_resumeSession (experimental, supported by Claude Code ACP)
			// This doesn't replay messages but reconnects to an existing session
			try {
				await this.request("unstable_resumeSession", {
					sessionId: ctx.sessionData.sessionId,
					cwd: this.options.cwd,
				});
				ctx.acpSessionId = ctx.sessionData.sessionId;
				// Messages are already loaded from disk above
				return ctx.acpSessionId;
			} catch {
				// Logged by request(), fall through to loadSession

				// Fall back to loadSession (requires loadSession capability, replays messages)
				// Note: loadSession replays messages via ACP callbacks, but we don't want
				// to generate UIMessageChunks for these. We'll just reconstruct the messages
				// from the session updates directly.
				try {
					// Set up temporary callback to capture replayed messages during load
					const replayedMessages: UIMessage[] = [];
					let currentMessage: UIMessage | null = null;

					// Temporarily set a callback that processes session updates directly
					// This is only for loadSession replay, not for regular streaming
					const replayCallback = (params: SessionNotification) => {
						const update = params.update;

						// Handle user_message_chunk - create user messages
						if (update.sessionUpdate === "user_message_chunk") {
							if (!currentMessage || currentMessage.role !== "user") {
								if (currentMessage) {
									replayedMessages.push(currentMessage);
								}
								currentMessage = createUIMessage("user");
							}
							const part = sessionUpdateToPart(update);
							if (part) {
								currentMessage.parts.push(part);
							}
						}
						// Handle agent_message_chunk - create assistant messages
						else if (
							update.sessionUpdate === "agent_message_chunk" ||
							update.sessionUpdate === "agent_thought_chunk" ||
							update.sessionUpdate === "tool_call" ||
							update.sessionUpdate === "tool_call_update" ||
							update.sessionUpdate === "plan"
						) {
							if (!currentMessage || currentMessage.role !== "assistant") {
								if (currentMessage) {
									replayedMessages.push(currentMessage);
								}
								currentMessage = createUIMessage("assistant");
							}
							const part = sessionUpdateToPart(update);
							if (part) {
								currentMessage.parts.push(part);
							}
						}
					};

					// Temporarily hijack the ACP sessionUpdate handler
					// We'll restore it after loadSession completes
					const connection = this.connection;
					if (connection) {
						// @ts-expect-error - accessing private client handler
						const originalHandler = connection.client.sessionUpdate;
						// @ts-expect-error - replacing private handler
						connection.client.sessionUpdate = async (
							params: SessionNotification,
						) => {
							replayCallback(params);
						};

						try {
							await this.request("loadSession", {
								sessionId: ctx.sessionData?.sessionId,
								cwd: this.options.cwd,
								mcpServers: [],
							});

							// Finalize last message
							if (currentMessage) {
								replayedMessages.push(currentMessage);
							}

							// Add replayed messages to session
							ctx.session.clearMessages();
							for (const msg of replayedMessages) {
								ctx.session.addMessage(msg);
							}

							ctx.acpSessionId = ctx.sessionData?.sessionId;
							return ctx.acpSessionId;
						} finally {
							// Restore original handler
							// @ts-expect-error - restoring private handler
							connection.client.sessionUpdate = originalHandler;
						}
					}

					throw new Error("No connection for loadSession");
				} catch (_error) {
					// Both resumeSession and loadSession failed
					// This is expected after agent restart - ACP agent has no memory of old sessions
					// We'll create a new ACP session but preserve the loaded messages
					console.warn(
						`Could not resume ACP session ${ctx.sessionData?.sessionId}, creating new session but preserving messages`,
					);
					// Fall through to newSession, but DON'T clear messages
				}
			}
		}

		// Create new session
		if (!this.connection) {
			throw new Error("Not connected");
		}

		// Only clear messages if this is truly a new session (no sessionData)
		// If we have sessionData, it means we loaded messages from disk but couldn't resume the ACP session
		if (!ctx.sessionData) {
			ctx.session.clearMessages();
		}

		const response = await this.request("newSession", {
			cwd: this.options.cwd,
			mcpServers: [],
		});

		ctx.acpSessionId = response.sessionId;
		ctx.sessionData = {
			sessionId: ctx.acpSessionId,
			cwd: this.options.cwd,
			createdAt: new Date().toISOString(),
		};

		// Only save session if persistence is enabled
		if (this.options.persistMessages) {
			await this.saveSessionData(resolvedSessionId, ctx.sessionData);
		}

		return ctx.acpSessionId;
	}

	setUpdateCallback(
		callback: AgentUpdateCallback | null,
		sessionId?: string,
	): void {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(resolvedSessionId);
		if (ctx) {
			ctx.callback = callback;
		}
	}

	async prompt(message: UIMessage, sessionId?: string): Promise<void> {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		const acpSessionId = await this.ensureSession(resolvedSessionId);
		const ctx = this.sessions.get(resolvedSessionId);
		if (!ctx) {
			throw new Error("Session context not found after ensureSession");
		}

		// Initialize stream state for this prompt
		// Use the message ID as the base for block IDs
		ctx.streamState = createStreamState();
		ctx.blockIds = createBlockIds(message.id);

		// Convert UIMessage to ACP ContentBlocks
		const content = uiMessageToContentBlocks(message);

		// Send to ACP
		await this.request("prompt", { sessionId: acpSessionId, prompt: content });
	}

	async cancel(sessionId?: string): Promise<void> {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(resolvedSessionId);
		if (!ctx || !ctx.acpSessionId) {
			return;
		}
		await this.request("cancel", { sessionId: ctx.acpSessionId });
	}

	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		this.connection = null;
		this.currentSessionId = null;

		// Invalidate all ACP session IDs since the agent is restarting
		// The SessionContext objects and their messages are preserved,
		// but we'll need to create new ACP sessions on next ensureSession()
		for (const ctx of this.sessions.values()) {
			ctx.acpSessionId = null;
		}
	}

	get isConnected(): boolean {
		return this.connection !== null;
	}

	// Update environment variables and restart the agent command if connected
	async updateEnvironment(update: EnvironmentUpdate): Promise<void> {
		// Merge the new environment variables with existing options
		this.options = {
			...this.options,
			env: {
				...this.options.env,
				...update.env,
			},
		};

		// Only restart if currently connected
		if (this.isConnected) {
			console.log("Restarting agent command with updated environment...");
			await this.disconnect();
			await this.connect();
			console.log("Agent command restarted with updated environment");
		} else {
			console.log(
				"Environment updated, will apply on next connect (agent not connected)",
			);
		}
	}

	// Get current environment variables
	getEnvironment(): Record<string, string> {
		return { ...this.options.env };
	}

	// Session management methods
	getSession(sessionId?: string): Session | undefined {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		let ctx = this.sessions.get(resolvedSessionId);

		// Auto-create default session if it doesn't exist
		if (!ctx && resolvedSessionId === this.DEFAULT_SESSION_ID) {
			ctx = {
				acpSessionId: null,
				session: new SessionImpl(resolvedSessionId),
				callback: null,
				streamState: null,
				blockIds: null,
				sessionData: null,
			};
			this.sessions.set(resolvedSessionId, ctx);
		}

		return ctx?.session;
	}

	listSessions(): string[] {
		return Array.from(this.sessions.keys());
	}

	createSession(sessionId: string): Session {
		if (this.sessions.has(sessionId)) {
			throw new Error(`Session ${sessionId} already exists`);
		}
		const ctx: SessionContext = {
			acpSessionId: null,
			session: new SessionImpl(sessionId),
			callback: null,
			streamState: null,
			blockIds: null,
			sessionData: null,
		};
		this.sessions.set(sessionId, ctx);
		return ctx.session;
	}

	async clearSession(sessionId?: string): Promise<void> {
		const resolvedSessionId = sessionId || this.DEFAULT_SESSION_ID;
		const ctx = this.sessions.get(resolvedSessionId);

		if (ctx) {
			// Clear from map
			this.sessions.delete(resolvedSessionId);

			// Clear persistence files if enabled
			if (this.options.persistMessages) {
				await this.clearSessionFiles(resolvedSessionId);
			}
		}

		// If clearing the current session, reset current session ID
		if (this.currentSessionId === resolvedSessionId) {
			this.currentSessionId = null;
		}
	}

	// Convenience methods for default session (backwards compatibility)
	getMessages(): UIMessage[] {
		const session = this.getSession();
		return session ? session.getMessages() : [];
	}

	addMessage(message: UIMessage): void {
		const session = this.getSession();
		if (session) {
			session.addMessage(message);
		}
	}

	updateMessage(id: string, updates: Partial<UIMessage>): void {
		const session = this.getSession();
		if (session) {
			session.updateMessage(id, updates);
		}
	}

	getLastAssistantMessage(): UIMessage | undefined {
		const session = this.getSession();
		return session?.getLastAssistantMessage();
	}

	clearMessages(): void {
		const session = this.getSession();
		if (session) {
			session.clearMessages();
		}
	}

	/**
	 * Update the session's message store from an ACP SessionUpdate.
	 * This accumulates parts in the last assistant message.
	 */
	private updateMessageFromACP(
		ctx: SessionContext,
		update: SessionUpdate,
	): void {
		const msg = ctx.session.getLastAssistantMessage();
		if (!msg) return;

		// Handle text chunks
		if (
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
		) {
			const text = update.content.text;
			const lastPart = msg.parts[msg.parts.length - 1];
			if (lastPart && lastPart.type === "text") {
				// Append to existing text part
				lastPart.text += text;
			} else {
				// Create new text part
				msg.parts.push({ type: "text", text });
			}
			ctx.session.updateMessage(msg.id, { parts: msg.parts });
		}
		// Handle reasoning chunks
		else if (
			update.sessionUpdate === "agent_thought_chunk" &&
			update.content.type === "text"
		) {
			const text = update.content.text;
			const lastPart = msg.parts[msg.parts.length - 1];
			if (lastPart && lastPart.type === "reasoning") {
				// Append to existing reasoning part
				lastPart.text += text;
			} else {
				// Create new reasoning part
				msg.parts.push({ type: "reasoning", text });
			}
			ctx.session.updateMessage(msg.id, { parts: msg.parts });
		}
		// Handle tool calls
		else if (
			update.sessionUpdate === "tool_call" ||
			update.sessionUpdate === "tool_call_update"
		) {
			const toolCallId = update.toolCallId;
			const existingPart = msg.parts.find(
				(p) => p.type === "dynamic-tool" && p.toolCallId === toolCallId,
			);

			// Extract tool name from _meta.claudeCode.toolName, falling back to title
			const meta = update._meta as
				| { [key: string]: unknown }
				| null
				| undefined;
			const toolName = extractToolName(update.title ?? undefined, meta);
			const content = update.content as ToolCallContent[] | null | undefined;

			if (existingPart && existingPart.type === "dynamic-tool") {
				existingPart.toolName = toolName;
				if (update.title) {
					existingPart.title = update.title;
				}
				if (update.rawInput !== undefined) {
					existingPart.input = update.rawInput;
				}
				if (update.status === "completed") {
					existingPart.state = "output-available";
					existingPart.output = extractToolOutput(
						update.rawOutput,
						content,
						meta,
					);
				} else if (update.status === "failed") {
					existingPart.state = "output-error";
					const output = extractToolOutput(update.rawOutput, content, meta);
					existingPart.errorText = String(output || "Tool call failed");
				} else if (update.status === "in_progress") {
					existingPart.state = "input-available";
				}
			} else {
				msg.parts.push({
					type: "dynamic-tool",
					toolCallId,
					toolName,
					title: update.title ?? undefined,
					state: "input-streaming",
					input: update.rawInput,
				});
			}
			ctx.session.updateMessage(msg.id, { parts: msg.parts });
		}
		// Handle plan updates
		else if (update.sessionUpdate === "plan") {
			const toolCallId = `plan-${Date.now()}`;
			msg.parts.push({
				type: "dynamic-tool",
				toolCallId,
				toolName: "TodoWrite",
				title: "Plan",
				state: "output-available",
				input: {},
				output: update.entries,
			});
			ctx.session.updateMessage(msg.id, { parts: msg.parts });
		}
	}

	// Persistence helpers for per-session files
	private getSessionDir(sessionId: string): string {
		const baseDir =
			process.env.SESSION_BASE_DIR || "/home/discobot/.config/discobot/sessions";
		return join(baseDir, sessionId);
	}

	private getSessionFile(sessionId: string): string {
		return join(this.getSessionDir(sessionId), "session.json");
	}

	private getMessagesFile(sessionId: string): string {
		return join(this.getSessionDir(sessionId), "messages.json");
	}

	private async loadSessionData(
		sessionId: string,
	): Promise<SessionData | null> {
		try {
			const sessionFile = this.getSessionFile(sessionId);

			// Migration: Check for old session file format (backwards compatibility)
			if (!existsSync(sessionFile) && sessionId === this.DEFAULT_SESSION_ID) {
				await this.migrateOldSessionFiles();
			}

			if (!existsSync(sessionFile)) {
				return null;
			}
			const content = await readFile(sessionFile, "utf-8");
			const data = JSON.parse(content) as SessionData;
			console.log(`Loaded session data for ${sessionId} from ${sessionFile}`);
			return data;
		} catch (error) {
			console.error(`Failed to load session data for ${sessionId}:`, error);
			return null;
		}
	}

	private async saveSessionData(
		sessionId: string,
		data: SessionData,
	): Promise<void> {
		try {
			const sessionFile = this.getSessionFile(sessionId);
			const dir = dirname(sessionFile);
			if (!existsSync(dir)) {
				await mkdir(dir, { recursive: true });
			}
			await writeFile(sessionFile, JSON.stringify(data, null, 2), "utf-8");
			console.log(`Saved session data for ${sessionId} to ${sessionFile}`);
		} catch (error) {
			console.error(`Failed to save session data for ${sessionId}:`, error);
			throw error;
		}
	}

	private async loadSessionMessages(sessionId: string): Promise<UIMessage[]> {
		try {
			const messagesFile = this.getMessagesFile(sessionId);

			// Migration: Check for old messages file format (backwards compatibility)
			if (!existsSync(messagesFile) && sessionId === this.DEFAULT_SESSION_ID) {
				await this.migrateOldSessionFiles();
			}

			if (!existsSync(messagesFile)) {
				return [];
			}
			const content = await readFile(messagesFile, "utf-8");
			const messages = JSON.parse(content) as UIMessage[];
			console.log(
				`Loaded ${messages.length} messages for ${sessionId} from ${messagesFile}`,
			);
			return messages;
		} catch (error) {
			console.error(`Failed to load messages for ${sessionId}:`, error);
			return [];
		}
	}

	async saveSessionMessages(sessionId: string): Promise<void> {
		try {
			const ctx = this.sessions.get(sessionId);
			if (!ctx) return;

			const messagesFile = this.getMessagesFile(sessionId);
			const dir = dirname(messagesFile);
			if (!existsSync(dir)) {
				await mkdir(dir, { recursive: true });
			}
			const messages = ctx.session.getMessages();
			await writeFile(messagesFile, JSON.stringify(messages, null, 2), "utf-8");
			console.log(
				`Saved ${messages.length} messages for ${sessionId} to ${messagesFile}`,
			);
		} catch (error) {
			console.error(`Failed to save messages for ${sessionId}:`, error);
		}
	}

	private async clearSessionFiles(sessionId: string): Promise<void> {
		try {
			const sessionFile = this.getSessionFile(sessionId);
			const messagesFile = this.getMessagesFile(sessionId);

			if (existsSync(sessionFile)) {
				await unlink(sessionFile);
			}
			if (existsSync(messagesFile)) {
				await unlink(messagesFile);
			}
			console.log(`Cleared session files for ${sessionId}`);
		} catch (error) {
			console.error(`Failed to clear session files for ${sessionId}:`, error);
		}
	}

	/**
	 * Migrate old session files to new per-session structure.
	 * This ensures backwards compatibility with sessions created before multi-session support.
	 *
	 * Old format:
	 * - /home/discobot/.config/discobot/agent-session.json
	 * - /home/discobot/.config/discobot/agent-messages.json
	 *
	 * New format:
	 * - /home/discobot/.config/discobot/sessions/default/session.json
	 * - /home/discobot/.config/discobot/sessions/default/messages.json
	 */
	private async migrateOldSessionFiles(): Promise<void> {
		try {
			const oldSessionFile =
				process.env.SESSION_FILE ||
				"/home/discobot/.config/discobot/agent-session.json";
			const oldMessagesFile =
				process.env.MESSAGES_FILE ||
				"/home/discobot/.config/discobot/agent-messages.json";

			const hasOldSession = existsSync(oldSessionFile);
			const hasOldMessages = existsSync(oldMessagesFile);

			if (!hasOldSession && !hasOldMessages) {
				// No old files to migrate
				return;
			}

			console.log("Migrating old session files to new format...");

			// Create new directory structure
			const newSessionDir = this.getSessionDir(this.DEFAULT_SESSION_ID);
			if (!existsSync(newSessionDir)) {
				await mkdir(newSessionDir, { recursive: true });
			}

			// Migrate session file
			if (hasOldSession) {
				const content = await readFile(oldSessionFile, "utf-8");
				const newSessionFile = this.getSessionFile(this.DEFAULT_SESSION_ID);
				await writeFile(newSessionFile, content, "utf-8");
				console.log(
					`Migrated session file: ${oldSessionFile} -> ${newSessionFile}`,
				);

				// Remove old file
				await unlink(oldSessionFile);
			}

			// Migrate messages file
			if (hasOldMessages) {
				const content = await readFile(oldMessagesFile, "utf-8");
				const newMessagesFile = this.getMessagesFile(this.DEFAULT_SESSION_ID);
				await writeFile(newMessagesFile, content, "utf-8");
				console.log(
					`Migrated messages file: ${oldMessagesFile} -> ${newMessagesFile}`,
				);

				// Remove old file
				await unlink(oldMessagesFile);
			}

			console.log("Migration complete!");
		} catch (error) {
			console.error("Failed to migrate old session files:", error);
			// Don't throw - this is a best-effort migration
		}
	}
}
