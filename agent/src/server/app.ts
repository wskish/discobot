import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { ACPClient } from "../acp/client.js";
import {
	createUIMessage,
	generateMessageId,
	sessionUpdateToUIPart,
	uiMessageToContentBlocks,
} from "../acp/translate.js";
import { authMiddleware } from "../auth/middleware.js";
import { checkCredentialsChanged } from "../credentials/credentials.js";
import {
	addMessage,
	clearSession,
	getLastAssistantMessage,
	getMessages,
	updateMessage,
} from "../store/session.js";

// Header name for credentials passed from server
const CREDENTIALS_HEADER = "X-Octobot-Credentials";

export interface AppOptions {
	agentCommand: string;
	agentArgs: string[];
	agentCwd: string;
	enableLogging?: boolean;
	/** Salted hash of shared secret (from OCTOBOT_SECRET env var) for auth enforcement */
	sharedSecretHash?: string;
}

export function createApp(options: AppOptions) {
	const app = new Hono();

	// Create ACP client
	const acpClient = new ACPClient({
		command: options.agentCommand,
		args: options.agentArgs,
		cwd: options.agentCwd,
	});

	if (options.enableLogging) {
		app.use("*", logger());
	}

	// Apply auth middleware if shared secret is configured
	if (options.sharedSecretHash) {
		app.use("*", authMiddleware(options.sharedSecretHash));
	}

	app.get("/", (c) => {
		return c.json({ status: "ok", service: "agent" });
	});

	app.get("/health", (c) => {
		return c.json({ healthy: true, connected: acpClient.isConnected });
	});

	// GET /chat - Return all messages
	app.get("/chat", async (c) => {
		// Ensure session is loaded (which loads past messages)
		if (!acpClient.isConnected) {
			await acpClient.connect();
		}
		await acpClient.ensureSession();

		const messages = getMessages();
		return c.json({ messages });
	});

	// POST /chat - Send messages and stream response
	app.post("/chat", async (c) => {
		const reqId = crypto.randomUUID().slice(0, 8);
		const log = (data: Record<string, unknown>) =>
			console.log(JSON.stringify({ reqId, ...data }));

		const body = await c.req.json<{ messages: UIMessage[] }>();
		const { messages: inputMessages } = body;

		if (!inputMessages || !Array.isArray(inputMessages)) {
			return c.json({ error: "messages array required" }, 400);
		}

		// Get the last user message to send
		const lastUserMessage = inputMessages
			.filter((m) => m.role === "user")
			.pop();
		if (!lastUserMessage) {
			return c.json({ error: "No user message found" }, 400);
		}

		// Check for credential changes from header
		const credentialsHeader = c.req.header(CREDENTIALS_HEADER) || null;
		const { changed: credentialsChanged, env: credentialEnv } =
			checkCredentialsChanged(credentialsHeader);

		// If credentials changed, restart with new environment
		if (credentialsChanged) {
			await acpClient.updateEnvironment({ env: credentialEnv });
		}

		// Ensure connected and session exists BEFORE adding messages
		// (ensureSession may clear messages when creating a new session)
		if (!acpClient.isConnected) {
			await acpClient.connect();
		}
		await acpClient.ensureSession();

		// Use the incoming UIMessage directly, ensuring it has an ID
		const userMessage: UIMessage = {
			...lastUserMessage,
			id: lastUserMessage.id || generateMessageId(),
		};
		addMessage(userMessage);

		// Create assistant message placeholder
		const assistantMessage = createUIMessage("assistant");
		addMessage(assistantMessage);

		// Convert to ACP format
		const contentBlocks = uiMessageToContentBlocks(userMessage);

		// Stream SSE response
		return streamSSE(c, async (stream) => {
			let textBuffer = "";

			// Helper to log and send SSE
			const sendSSE = async (data: Record<string, unknown>) => {
				log({ sse: data });
				await stream.writeSSE({ data: JSON.stringify(data) });
			};

			// Set up update callback to stream responses
			acpClient.setUpdateCallback((params: SessionNotification) => {
				const update = params.update;
				const part = sessionUpdateToUIPart(update);

				// Log session update from ACP
				log({ sessionUpdate: update });

				if (part) {
					// Update the assistant message in store
					const currentMsg = getLastAssistantMessage();
					if (currentMsg) {
						// For text parts, we accumulate the text
						if (part.type === "text") {
							textBuffer += part.text;

							// Find existing text part or add new one
							const existingTextPart = currentMsg.parts.find(
								(p) => p.type === "text",
							);
							if (existingTextPart && existingTextPart.type === "text") {
								existingTextPart.text = textBuffer;
							} else {
								currentMsg.parts.push({ type: "text", text: textBuffer });
							}
						} else if (part.type === "dynamic-tool") {
							// Update or add tool invocation
							const toolPart = part as DynamicToolUIPart;
							const existingToolPart = currentMsg.parts.find(
								(p): p is DynamicToolUIPart =>
									p.type === "dynamic-tool" &&
									p.toolCallId === toolPart.toolCallId,
							);
							if (existingToolPart) {
								Object.assign(existingToolPart, toolPart);
							} else {
								currentMsg.parts.push(toolPart);
							}
						} else {
							currentMsg.parts.push(part);
						}

						updateMessage(currentMsg.id, { parts: currentMsg.parts });
					}

					// Send SSE event in UIMessage Stream format
					if (part.type === "text") {
						sendSSE({
							type: "text-delta",
							id: currentMsg?.id || "text",
							delta: part.text,
						});
					} else if (part.type === "dynamic-tool") {
						sendSSE({
							type: "tool-input-available",
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							input: part.input,
						});
					} else if (part.type === "reasoning") {
						sendSSE({
							type: "reasoning-delta",
							id: currentMsg?.id || "reasoning",
							delta: part.text,
						});
					}
				}
			});

			try {
				// Send prompt to ACP
				await acpClient.prompt(contentBlocks);

				// Send completion event
				await sendSSE({
					type: "finish",
					messageId: assistantMessage.id,
				});
			} catch (error) {
				// Extract error message from various error types (including JSON-RPC errors)
				let errorText = "Unknown error";
				if (error instanceof Error) {
					errorText = error.message;
				} else if (error && typeof error === "object") {
					const errorObj = error as Record<string, unknown>;
					if (typeof errorObj.message === "string") {
						errorText = errorObj.message;
						// Include details from data.details if available (JSON-RPC format)
						if (errorObj.data && typeof errorObj.data === "object") {
							const data = errorObj.data as Record<string, unknown>;
							if (typeof data.details === "string") {
								errorText = `${errorText}: ${data.details}`;
							}
						}
					}
				}

				// Send error event
				await sendSSE({ type: "error", errorText });
			} finally {
				acpClient.setUpdateCallback(null);
			}
		});
	});

	// DELETE /chat - Clear session and messages
	app.delete("/chat", async (c) => {
		await clearSession();
		return c.json({ success: true });
	});

	return { app, acpClient };
}
