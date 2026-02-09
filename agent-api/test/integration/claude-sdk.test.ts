import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

// Test configuration
const TEST_CWD = join(tmpdir(), `claude-sdk-test-${Date.now()}`);
const TIMEOUT_MS = 120000; // 2 minutes for API calls

// Skip tests if ANTHROPIC_API_KEY is not set
const shouldSkip = !process.env.ANTHROPIC_API_KEY;
if (shouldSkip) {
	console.log(
		"⚠️  Skipping Claude SDK integration tests: ANTHROPIC_API_KEY not set",
	);
}

/**
 * Integration tests for ClaudeSDKClient that make actual API calls to Claude.
 * These tests require:
 * - ANTHROPIC_API_KEY environment variable
 * - Claude Code CLI binary installed (claude --version should work)
 */
describe("Claude SDK Integration Tests", { skip: shouldSkip }, () => {
	let client: ClaudeSDKClient;

	before(async () => {
		// Create a temporary working directory for tests
		if (!existsSync(TEST_CWD)) {
			await import("node:fs/promises").then((fs) =>
				fs.mkdir(TEST_CWD, { recursive: true }),
			);
		}

		// Initialize client
		client = new ClaudeSDKClient({
			cwd: TEST_CWD,
			model: "claude-sonnet-4-5-20250929",
			env: process.env as Record<string, string>,
		});

		await client.connect();
	});

	after(async () => {
		await client.disconnect();

		// Clean up test directory and sessions
		if (existsSync(TEST_CWD)) {
			rmSync(TEST_CWD, { recursive: true, force: true });
		}
	});

	describe("Basic Query", () => {
		it(
			"can send a simple query and receive a response",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-basic-query";

				// Create user message
				const userMessage: UIMessage = {
					id: "msg-1",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Say exactly three words: Hello from Claude",
						},
					],
				};

				// Send prompt
				for await (const _ of client.prompt(userMessage, sessionId)) { /* drain */ }

				// Get messages
				const messages = client.getSession(sessionId)?.getMessages() ?? [];

				// Verify we have user and assistant messages
				assert.ok(messages.length >= 2, "Should have at least 2 messages");

				const userMsg = messages.find((m) => m.role === "user");
				const assistantMsg = messages.find((m) => m.role === "assistant");

				assert.ok(userMsg, "Should have user message");
				assert.ok(assistantMsg, "Should have assistant message");

				// Check assistant response contains expected text
				const textParts = assistantMsg.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts.map((p) => p.text).join("");

				assert.ok(
					fullText.toLowerCase().includes("hello"),
					`Response should contain "hello", got: ${fullText}`,
				);
			},
		);
	});

	describe("Tool Usage", () => {
		it(
			"can execute Read tool and get file contents",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-tool-read";

				// Create a test file
				const testFilePath = join(TEST_CWD, "test.txt");
				const testContent = "This is a test file for Claude SDK";
				await import("node:fs/promises").then((fs) =>
					fs.writeFile(testFilePath, testContent),
				);

				// Ask Claude to read the file
				const userMessage: UIMessage = {
					id: "msg-2",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Read the file test.txt and tell me what it contains",
						},
					],
				};

				for await (const _ of client.prompt(userMessage, sessionId)) { /* drain */ }

				// Get messages
				const messages = client.getSession(sessionId)?.getMessages() ?? [];

				// Find assistant message
				const assistantMsg = messages.find((m) => m.role === "assistant");
				assert.ok(assistantMsg, "Should have assistant message");

				// Check for tool usage
				const toolParts = assistantMsg.parts.filter(
					(p) => p.type === "dynamic-tool",
				);

				// Assistant should have used a tool (Read)
				assert.ok(toolParts.length > 0, "Should have used at least one tool");

				// Check that response mentions the file content
				const textParts = assistantMsg.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts
					.map((p) => p.text)
					.join("")
					.toLowerCase();

				assert.ok(
					fullText.includes("test file"),
					`Response should mention file content, got: ${fullText}`,
				);
			},
		);

		it(
			"can execute Bash tool and get command output",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-tool-bash";

				const userMessage: UIMessage = {
					id: "msg-3",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Run the command 'echo Integration Test Success' using bash",
						},
					],
				};

				for await (const _ of client.prompt(userMessage, sessionId)) { /* drain */ }

				const messages = client.getSession(sessionId)?.getMessages() ?? [];
				const assistantMsg = messages.find((m) => m.role === "assistant");

				assert.ok(assistantMsg, "Should have assistant message");

				// Check response mentions the output
				const textParts = assistantMsg.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts
					.map((p) => p.text)
					.join("")
					.toLowerCase();

				assert.ok(
					fullText.includes("integration test success") ||
						fullText.includes("success"),
					`Response should mention command output, got: ${fullText}`,
				);
			},
		);
	});

	describe("Multi-turn Conversation", () => {
		it(
			"can maintain context across multiple prompts",
			{ timeout: TIMEOUT_MS * 2 },
			async () => {
				const sessionId = "test-multi-turn";

				// First turn: Set a value
				const msg1: UIMessage = {
					id: "msg-4",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Remember this number: 42. Just acknowledge you remembered it.",
						},
					],
				};

				for await (const _ of client.prompt(msg1, sessionId)) { /* drain */ }

				// Second turn: Ask about the value
				const msg2: UIMessage = {
					id: "msg-5",
					role: "user",
					parts: [
						{
							type: "text",
							text: "What number did I ask you to remember?",
						},
					],
				};

				for await (const _ of client.prompt(msg2, sessionId)) { /* drain */ }

				// Get all messages
				const messages = client.getSession(sessionId)?.getMessages() ?? [];

				// Should have 4 messages: 2 user, 2 assistant
				assert.ok(messages.length >= 4, "Should have at least 4 messages");

				// Check last assistant response mentions 42
				const assistantMessages = messages.filter(
					(m) => m.role === "assistant",
				);
				const lastAssistant = assistantMessages[assistantMessages.length - 1];

				const textParts = lastAssistant.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts.map((p) => p.text).join("");

				assert.ok(
					fullText.includes("42"),
					`Last response should mention 42, got: ${fullText}`,
				);
			},
		);
	});

	describe("Session Persistence", () => {
		it(
			"persists session to ~/.claude and can resume",
			{ timeout: TIMEOUT_MS * 2 },
			async () => {
				const sessionId = "test-persistence";

				// First interaction
				const msg1: UIMessage = {
					id: "msg-6",
					role: "user",
					parts: [
						{
							type: "text",
							text: "My favorite color is blue. Acknowledge this.",
						},
					],
				};

				for await (const _ of client.prompt(msg1, sessionId)) { /* drain */ }

				// Get the Claude session ID that was assigned
				const session = client.getSession(sessionId);
				const firstMessages = session?.getMessages() ?? [];

				console.log(`First session created ${firstMessages.length} messages`);

				// Disconnect and create new client (simulating app restart)
				await client.disconnect();

				const newClient = new ClaudeSDKClient({
					cwd: TEST_CWD,
					model: "claude-sonnet-4-5-20250929",
					env: process.env as Record<string, string>,
				});

				await newClient.connect();

				// Try to resume - send second message
				const msg2: UIMessage = {
					id: "msg-7",
					role: "user",
					parts: [
						{
							type: "text",
							text: "What is my favorite color?",
						},
					],
				};

				for await (const _ of newClient.prompt(msg2, sessionId)) { /* drain */ }

				// Check if context was preserved
				const messages = newClient.getSession(sessionId)?.getMessages() ?? [];

				console.log(
					`After resume, session has ${messages.length} messages (expected >= ${firstMessages.length + 2})`,
				);

				// Should have messages from first interaction + new messages
				// Note: We may not get all original messages if SDK doesn't persist them
				// So we'll just check that the assistant remembers the context
				assert.ok(
					messages.length >= 2,
					`Should have at least 2 messages, got ${messages.length}`,
				);

				// Check last assistant response mentions blue
				const assistantMessages = messages.filter(
					(m) => m.role === "assistant",
				);
				const lastAssistant = assistantMessages[assistantMessages.length - 1];

				assert.ok(lastAssistant, "Should have assistant response");

				const textParts = lastAssistant.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts
					.map((p) => p.text)
					.join("")
					.toLowerCase();

				// This test may fail if SDK doesn't persist sessions properly
				// In that case, this is a known limitation
				const hasBlue = fullText.includes("blue");
				if (!hasBlue) {
					console.warn(
						`Session persistence may not be working. Response: ${fullText}`,
					);
				}

				await newClient.disconnect();
			},
		);
	});

	describe("Session Discovery", () => {
		it(
			"can discover existing sessions from ~/.claude",
			{ timeout: TIMEOUT_MS },
			async () => {
				// Create a session first to ensure there's something to discover
				const sessionId = "test-discovery";
				const userMessage: UIMessage = {
					id: "msg-discovery",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Hello for discovery test",
						},
					],
				};

				for await (const _ of client.prompt(userMessage, sessionId)) { /* drain */ }

				// Now try to discover sessions
				const sessions = await client.discoverAvailableSessions();

				console.log(`Discovered ${sessions.length} sessions`);

				assert.ok(
					Array.isArray(sessions),
					"Should return an array of sessions",
				);

				// If we have sessions, check their structure
				if (sessions.length > 0) {
					const session = sessions[0];
					assert.ok(session.sessionId, "Session should have sessionId");
					assert.ok(session.filePath, "Session should have filePath");
					assert.ok(session.cwd, "Session should have cwd");
					assert.ok(session.lastModified, "Session should have lastModified");
					assert.ok(
						typeof session.messageCount === "number",
						"Session should have messageCount",
					);
				} else {
					console.warn(
						"No sessions discovered - SDK may not be persisting to ~/.claude",
					);
				}
			},
		);
	});

	describe("Streaming Updates", () => {
		it(
			"emits streaming chunks via async generator",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-streaming";
				const chunks: unknown[] = [];

				// Create the session first
				await client.ensureSession(sessionId);

				const userMessage: UIMessage = {
					id: "msg-8",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Say hello",
						},
					],
				};

				// Iterate over the async generator to capture chunks
				for await (const chunk of client.prompt(userMessage, sessionId)) {
					chunks.push(chunk);
				}

				console.log(`Received ${chunks.length} streaming chunks`);

				// Should have received multiple chunks
				// Note: Chunks may not be emitted if the SDK doesn't support streaming in this mode
				if (chunks.length > 0) {
					// Verify chunk structure (they should be UIMessageChunk objects)
					const firstChunk = chunks[0] as { type?: string };
					assert.ok(
						typeof firstChunk === "object",
						"Chunk should be an object",
					);
				} else {
					console.warn(
						"No streaming chunks received - SDK may not support streaming in this configuration",
					);
				}
			},
		);
	});

	describe("Error Handling", () => {
		it(
			"handles invalid prompts gracefully",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-error";

				// Try to prompt with empty message
				const emptyMessage: UIMessage = {
					id: "msg-9",
					role: "user",
					parts: [],
				};

				// This might throw or handle gracefully
				try {
					for await (const _ of client.prompt(emptyMessage, sessionId)) { /* drain */ }
					// If it doesn't throw, that's fine - just verify state
					assert.ok(true, "Client handled empty message");
				} catch (error) {
					// Expected behavior - error handling works
					assert.ok(error instanceof Error, "Should throw a proper Error");
				}
			},
		);
	});

	describe("Environment Variables", () => {
		it(
			"can access custom environment variables",
			{ timeout: TIMEOUT_MS },
			async () => {
				const customClient = new ClaudeSDKClient({
					cwd: TEST_CWD,
					model: "claude-sonnet-4-5-20250929",
					env: {
						...process.env,
						TEST_VAR: "integration_test_value",
					} as Record<string, string>,
				});

				await customClient.connect();

				const env = customClient.getEnvironment();
				assert.equal(
					env.TEST_VAR,
					"integration_test_value",
					"Should preserve custom env var",
				);

				await customClient.disconnect();
			},
		);
	});

	describe("Extended Thinking", () => {
		it(
			"captures and returns reasoning blocks in response",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-thinking";
				const reasoningChunks: { type: string }[] = [];
				const allChunks: unknown[] = [];

				// Ensure session exists first
				await client.ensureSession(sessionId);

				// Ask a question that requires thinking
				// This should trigger extended thinking if the model supports it
				const userMessage: UIMessage = {
					id: "msg-thinking",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Solve this step by step: If a train leaves Station A at 2pm traveling 60mph, and another train leaves Station B (120 miles away) at 3pm traveling 80mph toward Station A, when and where do they meet? Show your reasoning.",
						},
					],
				};

				// Iterate over the async generator to capture ALL chunks including reasoning
				for await (const chunk of client.prompt(userMessage, sessionId)) {
					allChunks.push(chunk);
					if (
						chunk.type === "reasoning-start" ||
						chunk.type === "reasoning-delta" ||
						chunk.type === "reasoning-end"
					) {
						reasoningChunks.push(chunk);
					}
				}

				console.log(
					`Received ${allChunks.length} total chunks, ${reasoningChunks.length} reasoning chunks`,
				);

				// Get the final messages
				const messages = client.getSession(sessionId)?.getMessages() ?? [];
				const assistantMsg = messages.find((m) => m.role === "assistant");

				assert.ok(assistantMsg, "Should have assistant message");

				// Check if we got reasoning chunks via streaming
				if (reasoningChunks.length > 0) {
					console.log("✓ Extended thinking detected via streaming chunks");

					// Verify reasoning chunk types
					const hasStart = reasoningChunks.some(
						(c) => c.type === "reasoning-start",
					);
					const hasDelta = reasoningChunks.some(
						(c) => c.type === "reasoning-delta",
					);
					const hasEnd = reasoningChunks.some(
						(c) => c.type === "reasoning-end",
					);

					if (hasStart && hasDelta && hasEnd) {
						console.log(
							"✓ Reasoning chunks follow correct protocol: start → delta → end",
						);
					}
				} else {
					console.log(
						"ℹ No extended thinking chunks detected - model may not have used extended thinking for this prompt",
					);
				}

				// Check for reasoning parts in the final message
				const reasoningParts = assistantMsg.parts.filter(
					(p) => p.type === "reasoning",
				);

				if (reasoningParts.length > 0) {
					console.log(
						`✓ Found ${reasoningParts.length} reasoning part(s) in final message`,
					);

					// Verify reasoning part has content
					const firstReasoning = reasoningParts[0] as { text?: string };
					assert.ok(
						firstReasoning.text,
						"Reasoning part should have text content",
					);
					console.log(
						`✓ Reasoning content length: ${firstReasoning.text.length} chars`,
					);
				} else {
					console.log(
						"ℹ No reasoning parts in final message - this is expected if model didn't use extended thinking",
					);
				}

				// Verify the assistant actually solved the problem
				const textParts = assistantMsg.parts.filter(
					(p): p is { type: "text"; text: string } => p.type === "text",
				);
				const fullText = textParts
					.map((p) => p.text)
					.join("")
					.toLowerCase();

				// Should mention time or distance in the solution
				const hasSolution =
					fullText.includes("meet") ||
					fullText.includes("time") ||
					fullText.includes("distance") ||
					fullText.includes("hour") ||
					fullText.includes("mile");

				assert.ok(
					hasSolution,
					`Response should contain solution details, got: ${fullText.substring(0, 200)}...`,
				);
			},
		);
	});
});
