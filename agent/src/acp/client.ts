import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
	type Agent,
	type Client,
	ClientSideConnection,
	type ContentBlock,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { UIMessage } from "ai";
import {
	addMessage,
	clearMessages,
	loadSession,
	type SessionData,
	saveSession,
} from "../store/session.js";
import { createUIMessage, sessionUpdateToUIPart } from "./translate.js";

export interface ACPClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	env?: Record<string, string>;
}

export interface EnvironmentUpdate {
	env: Record<string, string>;
}

export type SessionUpdateCallback = (update: SessionNotification) => void;

// Extract method names from ClientSideConnection that take a single param and return a Promise
type ConnectionMethods = {
	[K in keyof ClientSideConnection]: ClientSideConnection[K] extends (
		params: infer _P,
	) => Promise<infer _R>
		? K
		: never;
}[keyof ClientSideConnection];

export class ACPClient {
	private connection: ClientSideConnection | null = null;
	private process: ChildProcess | null = null;
	private sessionId: string | null = null;
	private sessionData: SessionData | null = null;
	private updateCallback: SessionUpdateCallback | null = null;

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
		const createClient = (_agent: Agent): Client => ({
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
				// Forward updates to the callback
				if (this.updateCallback) {
					this.updateCallback(params);
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

	async ensureSession(): Promise<string> {
		if (this.sessionId) {
			return this.sessionId;
		}

		// Try to load existing session
		this.sessionData = await loadSession();

		if (this.sessionData && this.connection) {
			// First try unstable_resumeSession (experimental, supported by Claude Code ACP)
			// This doesn't replay messages but reconnects to an existing session
			try {
				await this.request("unstable_resumeSession", {
					sessionId: this.sessionData.sessionId,
					cwd: this.options.cwd,
				});
				this.sessionId = this.sessionData.sessionId;
				return this.sessionId;
			} catch {
				// Logged by request(), fall through to loadSession

				// Fall back to loadSession (requires loadSession capability, replays messages)
				try {
					// Set up callback to capture replayed messages during load
					const replayedMessages: UIMessage[] = [];
					let currentMessage: UIMessage | null = null;

					const originalCallback = this.updateCallback;
					this.updateCallback = (params: SessionNotification) => {
						const update = params.update;

						// Handle user_message_chunk - create user messages
						if (update.sessionUpdate === "user_message_chunk") {
							if (!currentMessage || currentMessage.role !== "user") {
								if (currentMessage) {
									replayedMessages.push(currentMessage);
								}
								currentMessage = createUIMessage("user");
							}
							const part = sessionUpdateToUIPart(update);
							if (part) {
								currentMessage.parts.push(part);
							}
						}
						// Handle agent_message_chunk - create assistant messages
						else if (
							update.sessionUpdate === "agent_message_chunk" ||
							update.sessionUpdate === "agent_thought_chunk" ||
							update.sessionUpdate === "tool_call" ||
							update.sessionUpdate === "tool_call_update"
						) {
							if (!currentMessage || currentMessage.role !== "assistant") {
								if (currentMessage) {
									replayedMessages.push(currentMessage);
								}
								currentMessage = createUIMessage("assistant");
							}
							const part = sessionUpdateToUIPart(update);
							if (part) {
								currentMessage.parts.push(part);
							}
						}
					};

					await this.request("loadSession", {
						sessionId: this.sessionData.sessionId,
						cwd: this.options.cwd,
						mcpServers: [],
					});

					// Finalize last message
					if (currentMessage) {
						replayedMessages.push(currentMessage);
					}

					// Restore original callback
					this.updateCallback = originalCallback;

					// Add replayed messages to store
					clearMessages();
					for (const msg of replayedMessages) {
						addMessage(msg);
					}

					this.sessionId = this.sessionData.sessionId;
					return this.sessionId;
				} catch {
					// Logged by request(), fall through to newSession
				}
			}
		}

		// Create new session
		if (!this.connection) {
			throw new Error("Not connected");
		}

		clearMessages();

		const response = await this.request("newSession", {
			cwd: this.options.cwd,
			mcpServers: [],
		});

		this.sessionId = response.sessionId;
		this.sessionData = {
			sessionId: this.sessionId,
			cwd: this.options.cwd,
			createdAt: new Date().toISOString(),
		};

		await saveSession(this.sessionData);

		return this.sessionId;
	}

	setUpdateCallback(callback: SessionUpdateCallback | null): void {
		this.updateCallback = callback;
	}

	async prompt(content: ContentBlock[]): Promise<void> {
		const sessionId = await this.ensureSession();
		await this.request("prompt", { sessionId, prompt: content });
	}

	async cancel(): Promise<void> {
		if (!this.sessionId) {
			return;
		}
		await this.request("cancel", { sessionId: this.sessionId });
	}

	async disconnect(): Promise<void> {
		if (this.process) {
			this.process.kill();
			this.process = null;
		}
		this.connection = null;
		this.sessionId = null;
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
			console.log("Environment updated, will apply on next connect");
		}
	}

	// Get current environment variables
	getEnvironment(): Record<string, string> {
		return { ...this.options.env };
	}
}
