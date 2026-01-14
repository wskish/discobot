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
import {
	addMessage,
	clearMessages,
	loadSession,
	type SessionData,
	type SimpleMessage,
	saveSession,
} from "./session.js";
import { createSimpleMessage, sessionUpdateToSimplePart } from "./translate.js";

export interface ACPClientOptions {
	command: string;
	args?: string[];
	cwd: string;
	env?: Record<string, string>;
}

export type SessionUpdateCallback = (update: SessionNotification) => void;

export class ACPClient {
	private connection: ClientSideConnection | null = null;
	private process: ChildProcess | null = null;
	private sessionId: string | null = null;
	private sessionData: SessionData | null = null;
	private updateCallback: SessionUpdateCallback | null = null;

	constructor(private options: ACPClientOptions) {}

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
		await this.connection.initialize({
			protocolVersion: 1,
			clientInfo: {
				name: "agent-service",
				version: "1.0.0",
			},
			clientCapabilities: {},
		});

		console.log("ACP connection initialized");
	}

	async ensureSession(): Promise<string> {
		if (this.sessionId) {
			return this.sessionId;
		}

		// Try to load existing session
		this.sessionData = await loadSession();

		if (this.sessionData && this.connection) {
			// Try to load existing session (which replays messages)
			try {
				// Set up callback to capture replayed messages during load
				const replayedMessages: SimpleMessage[] = [];
				let currentMessage: SimpleMessage | null = null;

				const originalCallback = this.updateCallback;
				this.updateCallback = (params: SessionNotification) => {
					const update = params.update;

					// Handle user_message_chunk - create user messages
					if (update.sessionUpdate === "user_message_chunk") {
						if (!currentMessage || currentMessage.role !== "user") {
							if (currentMessage) {
								replayedMessages.push(currentMessage);
							}
							currentMessage = createSimpleMessage("user");
						}
						const part = sessionUpdateToSimplePart(update);
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
							currentMessage = createSimpleMessage("assistant");
						}
						const part = sessionUpdateToSimplePart(update);
						if (part) {
							currentMessage.parts.push(part);
						}
					}
				};

				await this.connection.loadSession({
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
				console.log(
					`Loaded session: ${this.sessionId} with ${replayedMessages.length} messages`,
				);
				return this.sessionId;
			} catch (error) {
				console.log("Failed to load session, trying resume:", error);

				// Try resume as fallback (doesn't replay messages)
				try {
					await this.connection.unstable_resumeSession({
						sessionId: this.sessionData.sessionId,
						cwd: this.options.cwd,
					});
					this.sessionId = this.sessionData.sessionId;
					console.log(`Resumed session: ${this.sessionId}`);
					return this.sessionId;
				} catch (resumeError) {
					console.log(
						"Failed to resume session, creating new one:",
						resumeError,
					);
				}
			}
		}

		// Create new session
		if (!this.connection) {
			throw new Error("Not connected");
		}

		clearMessages();

		const response = await this.connection.newSession({
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
		console.log(`Created new session: ${this.sessionId}`);

		return this.sessionId;
	}

	setUpdateCallback(callback: SessionUpdateCallback | null): void {
		this.updateCallback = callback;
	}

	async prompt(content: ContentBlock[]): Promise<void> {
		if (!this.connection) {
			throw new Error("Not connected");
		}

		const sessionId = await this.ensureSession();

		await this.connection.prompt({
			sessionId,
			prompt: content,
		});
	}

	async cancel(): Promise<void> {
		if (!this.connection || !this.sessionId) {
			return;
		}

		await this.connection.cancel({
			sessionId: this.sessionId,
		});
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
}
