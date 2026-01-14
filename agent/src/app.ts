import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { UIMessage } from "ai";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import { ACPClient } from "./acp-client.js";
import {
	addMessage,
	clearSession,
	getLastAssistantMessage,
	getMessages,
	type ToolInvocationPart,
	updateMessage,
} from "./session.js";
import {
	createSimpleMessage,
	generateMessageId,
	sessionUpdateToSimplePart,
	simpleMessageToContentBlocks,
	uiMessageToSimple,
} from "./translate.js";

export interface AppOptions {
	agentCommand: string;
	agentArgs: string[];
	agentCwd: string;
	enableLogging?: boolean;
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

		// Ensure connected and session exists BEFORE adding messages
		// (ensureSession may clear messages when creating a new session)
		if (!acpClient.isConnected) {
			await acpClient.connect();
		}
		await acpClient.ensureSession();

		// Convert to our simple format and add to store
		const userMessage = uiMessageToSimple(lastUserMessage);
		userMessage.id = lastUserMessage.id || generateMessageId();
		addMessage(userMessage);

		// Create assistant message placeholder
		const assistantMessage = createSimpleMessage("assistant");
		addMessage(assistantMessage);

		// Convert to ACP format
		const contentBlocks = simpleMessageToContentBlocks(userMessage);

		// Stream SSE response
		return streamSSE(c, async (stream) => {
			let textBuffer = "";

			// Set up update callback to stream responses
			acpClient.setUpdateCallback((params: SessionNotification) => {
				const update = params.update;
				const part = sessionUpdateToSimplePart(update);

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
						} else if (part.type === "tool-invocation") {
							// Update or add tool invocation
							const toolPart = part as ToolInvocationPart;
							const existingToolPart = currentMsg.parts.find(
								(p): p is ToolInvocationPart =>
									p.type === "tool-invocation" &&
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

					// Send SSE event
					if (part.type === "text") {
						stream.writeSSE({
							event: "text-delta",
							data: JSON.stringify({ text: part.text }),
						});
					} else if (part.type === "tool-invocation") {
						stream.writeSSE({
							event: "tool-invocation",
							data: JSON.stringify(part),
						});
					} else if (part.type === "reasoning") {
						stream.writeSSE({
							event: "reasoning",
							data: JSON.stringify({ text: part.text }),
						});
					}
				}
			});

			try {
				// Send prompt to ACP
				await acpClient.prompt(contentBlocks);

				// Send completion event
				await stream.writeSSE({
					event: "done",
					data: JSON.stringify({ messageId: assistantMessage.id }),
				});
			} catch (error) {
				console.error("Prompt error:", error);
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						error: error instanceof Error ? error.message : "Unknown error",
					}),
				});
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
