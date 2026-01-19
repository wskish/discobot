import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UIMessage } from "ai";
import type {
	ChatStartedResponse,
	ChatStatusResponse,
} from "../../src/api/types.js";
import { createApp } from "../../src/server/app.js";
import { clearMessages, clearSession } from "../../src/store/session.js";

// Response types
interface StatusResponse {
	status: string;
	service: string;
}

interface HealthResponse {
	healthy: boolean;
	connected: boolean;
}

interface ErrorResponse {
	error: string;
}

interface MessagesResponse {
	messages: UIMessage[];
}

interface DeleteResponse {
	success: boolean;
}

/**
 * Poll /chat/status until completion finishes or timeout.
 */
async function waitForCompletion(
	app: ReturnType<typeof createApp>["app"],
	timeoutMs = 120000,
	pollIntervalMs = 500,
): Promise<ChatStatusResponse> {
	const startTime = Date.now();

	while (Date.now() - startTime < timeoutMs) {
		const res = await app.request("/chat/status");
		const status = (await res.json()) as ChatStatusResponse;

		if (!status.isRunning) {
			return status;
		}

		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	throw new Error(`Completion did not finish within ${timeoutMs}ms`);
}

describe("Agent Service E2E Tests", () => {
	let app: ReturnType<typeof createApp>["app"];
	let acpClient: ReturnType<typeof createApp>["acpClient"];

	before(async () => {
		// Clear any existing session before tests
		await clearSession();

		const result = createApp({
			agentCommand: "claude-code-acp",
			agentArgs: [],
			agentCwd: process.cwd(),
			enableLogging: false,
		});
		app = result.app;
		acpClient = result.acpClient;
	});

	after(async () => {
		await acpClient.disconnect();
		await clearSession();
	});

	describe("GET /", () => {
		it("returns service status", async () => {
			const res = await app.request("/");
			assert.equal(res.status, 200);

			const body = (await res.json()) as StatusResponse;
			assert.equal(body.status, "ok");
			assert.equal(body.service, "agent");
		});
	});

	describe("GET /health", () => {
		it("returns health status", async () => {
			const res = await app.request("/health");
			assert.equal(res.status, 200);

			const body = (await res.json()) as HealthResponse;
			assert.equal(body.healthy, true);
			assert.equal(typeof body.connected, "boolean");
		});
	});

	describe("POST /chat", () => {
		it("returns 400 if messages array is missing", async () => {
			const res = await app.request("/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "messages array required");
		});

		it("returns 400 if no user message found", async () => {
			const res = await app.request("/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [{ id: "1", role: "assistant", parts: [] }],
				}),
			});
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "No user message found");
		});

		// This test requires a working Anthropic API connection
		// Run with: source ~/.bashrc.d/anthropic && pnpm test
		it(
			"starts completion and returns 202 Accepted",
			{ timeout: 120000 },
			async () => {
				clearMessages();

				const res = await app.request("/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						messages: [
							{
								id: "msg-1",
								role: "user",
								parts: [{ type: "text", text: "Say exactly: Hello World" }],
							},
						],
					}),
				});

				assert.equal(res.status, 202);

				const body = (await res.json()) as ChatStartedResponse;
				assert.equal(body.status, "started");
				assert.ok(body.completionId, "Should return a completionId");

				// Wait for completion to finish
				const finalStatus = await waitForCompletion(app);
				assert.equal(finalStatus.isRunning, false);
				assert.equal(
					finalStatus.error,
					null,
					"Completion should not have error",
				);
			},
		);
	});

	describe("GET /chat", () => {
		it("returns messages with expected content from previous POST", async () => {
			const res = await app.request("/chat");
			assert.equal(res.status, 200);

			const body = (await res.json()) as MessagesResponse;
			assert.ok(Array.isArray(body.messages), "Should return messages array");
			assert.ok(
				body.messages.length >= 2,
				"Should have at least user and assistant messages",
			);

			// Verify user message
			const userMessage = body.messages.find((m) => m.role === "user");
			assert.ok(userMessage, "Should have a user message");
			const userTextPart = userMessage.parts.find(
				(p): p is { type: "text"; text: string } => p.type === "text",
			);
			assert.ok(userTextPart, "User message should have a text part");
			assert.ok(
				userTextPart.text.includes("Say exactly: Hello World"),
				"User message should contain the original prompt",
			);

			// Verify assistant message
			const assistantMessage = body.messages.find(
				(m) => m.role === "assistant",
			);
			assert.ok(assistantMessage, "Should have an assistant message");
			const assistantTextParts = assistantMessage.parts.filter(
				(p): p is { type: "text"; text: string } => p.type === "text",
			);
			assert.ok(
				assistantTextParts.length > 0,
				"Assistant message should have text parts",
			);
			const fullAssistantText = assistantTextParts.map((p) => p.text).join("");
			assert.ok(
				fullAssistantText.toLowerCase().includes("hello world"),
				`Assistant response should contain 'Hello World', got: ${fullAssistantText}`,
			);
		});
	});

	describe("DELETE /chat", () => {
		it("clears session and messages", async () => {
			const res = await app.request("/chat", { method: "DELETE" });
			assert.equal(res.status, 200);

			const body = (await res.json()) as DeleteResponse;
			assert.equal(body.success, true);
		});
	});
});
