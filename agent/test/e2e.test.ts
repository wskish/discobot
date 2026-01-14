import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import {
	clearMessages,
	clearSession,
	type SimpleMessage,
} from "../src/session.js";

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
	messages: SimpleMessage[];
}

interface DeleteResponse {
	success: boolean;
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
			"streams SSE response for valid message",
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

				assert.equal(res.status, 200);
				assert.ok(
					res.headers.get("content-type")?.startsWith("text/event-stream"),
					"Should return SSE content type",
				);

				// Read the SSE stream
				const text = await res.text();
				const events = parseSSE(text);

				// Should have text-delta events and a done event
				const textDeltas = events.filter((e) => e.event === "text-delta");
				const doneEvents = events.filter((e) => e.event === "done");

				assert.ok(textDeltas.length > 0, "Should have text-delta events");
				assert.equal(
					doneEvents.length,
					1,
					"Should have exactly one done event",
				);

				// Verify we got some text content
				const fullText = textDeltas
					.map((e) => (JSON.parse(e.data) as { text: string }).text)
					.join("");
				assert.ok(fullText.length > 0, "Should have received text content");
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

// Helper to parse SSE text into events
function parseSSE(text: string): Array<{ event: string; data: string }> {
	const events: Array<{ event: string; data: string }> = [];
	const lines = text.split("\n");

	let currentEvent = "";
	let currentData = "";

	for (const line of lines) {
		if (line.startsWith("event:")) {
			currentEvent = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			currentData = line.slice(5).trim();
		} else if (line === "" && currentEvent) {
			events.push({ event: currentEvent, data: currentData });
			currentEvent = "";
			currentData = "";
		}
	}

	return events;
}
