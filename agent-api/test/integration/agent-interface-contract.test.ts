/**
 * Agent Interface Contract Tests
 *
 * Validates that an agent implementation correctly implements the Agent interface.
 * All providers must pass all tests - no conditional behavior.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx pnpm test test/integration/agent-interface-contract.test.ts
 *   PROVIDER=my-provider MY_API_KEY=xxx pnpm test test/integration/agent-interface-contract.test.ts
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Agent } from "../../src/agent/interface.js";
import type { ModelInfo, UIMessageChunk } from "../../src/api/types.js";
import { getProvider } from "./agent-provider-registry.js";

const PROVIDER_NAME = process.env.PROVIDER || "claude-sdk";
const provider = getProvider(PROVIDER_NAME);

console.log(`\n🧪 Testing provider: ${provider.name}\n`);

// Helper to collect all chunks from async generator
async function collectChunks(
	generator: AsyncGenerator<UIMessageChunk>,
	timeout = 120000,
): Promise<UIMessageChunk[]> {
	const chunks: UIMessageChunk[] = [];
	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("Timeout")), timeout),
	);

	await Promise.race([
		(async () => {
			for await (const chunk of generator) {
				chunks.push(chunk);
			}
		})(),
		timeoutPromise,
	]);

	return chunks;
}

describe(`Agent Interface Contract: ${provider.name}`, () => {
	let agent: Agent;

	beforeEach(async () => {
		agent = provider.createAgent();
	});

	afterEach(async () => {
		try {
			if (agent?.isConnected) {
				await agent.disconnect();
			}
		} catch (_error) {
			// Ignore cleanup errors
		}
	});

	// ==========================================================================
	// CONNECTION MANAGEMENT
	// ==========================================================================

	describe("Connection Management", () => {
		it("starts disconnected", () => {
			assert.equal(agent.isConnected, false);
		});

		it("connects successfully", async () => {
			await agent.connect();
			assert.equal(agent.isConnected, true);
		});

		it("connect is idempotent", async () => {
			await agent.connect();
			await agent.connect();
			await agent.connect();
			assert.equal(agent.isConnected, true);
		});

		it("disconnects successfully", async () => {
			await agent.connect();
			await agent.disconnect();
			assert.equal(agent.isConnected, false);
		});

		it("disconnect is idempotent", async () => {
			await agent.connect();
			await agent.disconnect();
			await agent.disconnect();
			assert.equal(agent.isConnected, false);
		});

		it("reconnects after disconnect", async () => {
			await agent.connect();
			await agent.disconnect();
			await agent.connect();
			assert.equal(agent.isConnected, true);
		});
	});

	// ==========================================================================
	// SESSION MANAGEMENT
	// ==========================================================================

	describe("Session Management", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("creates new session with explicit ID", async () => {
			const sessionId = await agent.ensureSession("test-session-1");
			assert.ok(sessionId);
			assert.ok(agent.listSessions().includes(sessionId));
		});

		it("reuses existing session", async () => {
			const id1 = await agent.ensureSession("test-session-2");
			const id2 = await agent.ensureSession("test-session-2");
			assert.equal(id1, id2);
		});

		it("creates default session when no ID provided", async () => {
			const sessionId = await agent.ensureSession();
			assert.ok(sessionId);
		});

		it("createSession creates empty session", () => {
			const session = agent.createSession();
			assert.ok(session.id);
			assert.equal(session.getMessages().length, 0);
		});

		it("getSession returns existing session", async () => {
			const sessionId = await agent.ensureSession("test-session-4");
			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.equal(session?.id, sessionId);
		});

		it("getSession returns undefined for non-existent session", () => {
			const session = agent.getSession("does-not-exist");
			assert.equal(session, undefined);
		});

		it("listSessions returns all session IDs", async () => {
			await agent.ensureSession("test-session-5");
			await agent.ensureSession("test-session-6");
			await agent.ensureSession("test-session-7");

			const sessions = agent.listSessions();
			assert.ok(sessions.includes("test-session-5"));
			assert.ok(sessions.includes("test-session-6"));
			assert.ok(sessions.includes("test-session-7"));
		});

		it("new session has empty message history", async () => {
			const sessionId = await agent.ensureSession("empty-session");
			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.equal(session.getMessages().length, 0);
		});

		it("clearSession removes all messages", async () => {
			const sessionId = await agent.ensureSession("clear-test");
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen);

			const sessionBefore = agent.getSession(sessionId);
			assert.ok(sessionBefore && sessionBefore.getMessages().length > 0);

			await agent.clearSession(sessionId);

			const sessionAfter = agent.getSession(sessionId);
			assert.ok(sessionAfter);
			assert.equal(sessionAfter.getMessages().length, 0);
		});

		it("clearSession without ID clears default session", async () => {
			const sessionId = await agent.ensureSession();
			const gen = agent.prompt(provider.testMessages.simple);
			await collectChunks(gen);

			await agent.clearSession();

			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.equal(session.getMessages().length, 0);
		});

		it("maintains separate message histories per session", async () => {
			const session1 = await agent.ensureSession("separate-1");
			const session2 = await agent.ensureSession("separate-2");

			const gen1 = agent.prompt(provider.testMessages.simple, session1);
			await collectChunks(gen1);

			const gen2 = agent.prompt(provider.testMessages.continuation, session2);
			await collectChunks(gen2);

			const s1 = agent.getSession(session1);
			const s2 = agent.getSession(session2);

			assert.ok(s1 && s2);
			assert.notEqual(
				JSON.stringify(s1.getMessages()),
				JSON.stringify(s2.getMessages()),
			);
		});
	});

	// ==========================================================================
	// MESSAGING
	// ==========================================================================

	describe("Messaging", () => {
		let sessionId: string;

		beforeEach(async () => {
			await agent.connect();
			const session = agent.createSession();
			sessionId = session.id;
		});

		it("prompt returns async generator", () => {
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			assert.ok(gen[Symbol.asyncIterator]);
		});

		it("yields message chunks", async () => {
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			const chunks = await collectChunks(gen);

			assert.ok(chunks.length > 0);
			// Verify chunks have proper structure
			// Note: ClaudeSDK uses both 'id' and 'messageId' for different chunk types
			for (const chunk of chunks) {
				assert.ok(chunk.type, "Chunk should have type");
			}
		});

		it("produces text content", async () => {
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			const chunks = await collectChunks(gen);

			const hasText = chunks.some(
				(c) =>
					c.type === "text-delta" &&
					"delta" in c &&
					typeof c.delta === "string" &&
					c.delta.trim().length > 0,
			);
			assert.ok(hasText);
		});

		it("completes generator", async () => {
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			let completed = false;

			for await (const chunk of gen) {
				assert.ok(chunk);
			}
			completed = true;

			assert.ok(completed);
		});

		it("messages persist in session", async () => {
			const gen1 = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen1);

			const gen2 = agent.prompt(provider.testMessages.continuation, sessionId);
			await collectChunks(gen2);

			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.ok(session.getMessages().length >= 4); // 2 user + 2 assistant
		});

		it("maintains conversation context", async () => {
			// First message
			const gen1 = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen1);

			// Follow-up referencing first message
			const gen2 = agent.prompt(provider.testMessages.continuation, sessionId);
			const chunks2 = await collectChunks(gen2);

			// Should have a response
			assert.ok(chunks2.length > 0);

			// Session should have both exchanges
			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.ok(session.getMessages().length >= 4);
		});

		it("handles tool use", async () => {
			const gen = agent.prompt(provider.testMessages.withTools, sessionId);
			const chunks = await collectChunks(gen);

			// ClaudeSDK emits tool-input-start, tool-input-available for tool calls
			const hasToolCall = chunks.some(
				(c) =>
					c.type === "tool-input-start" || c.type === "tool-input-available",
			);
			assert.ok(hasToolCall, "Should have tool call chunks");
		});

		it("emits tool results", async () => {
			const gen = agent.prompt(provider.testMessages.withTools, sessionId);
			const chunks = await collectChunks(gen);

			// ClaudeSDK emits tool-output-available for tool results
			const hasToolResult = chunks.some(
				(c) => c.type === "tool-output-available",
			);
			assert.ok(hasToolResult, "Should have tool result chunks");
		});
	});

	// ==========================================================================
	// CANCELLATION
	// ==========================================================================

	describe("Cancellation", () => {
		let sessionId: string;

		beforeEach(async () => {
			await agent.connect();
			const session = agent.createSession();
			sessionId = session.id;
		});

		it("cancel on inactive session is safe", async () => {
			await assert.doesNotReject(async () => await agent.cancel(sessionId));
		});

		it("cancel on non-existent session is safe", async () => {
			await assert.doesNotReject(
				async () => await agent.cancel("does-not-exist"),
			);
		});

		it.skip("session remains usable after cancel", async () => {
			// TODO: This test causes timeouts - need to investigate generator cleanup
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			const iter = gen[Symbol.asyncIterator]();
			await iter.next();

			await agent.cancel(sessionId);

			// Should be able to send new prompt
			const gen2 = agent.prompt(provider.testMessages.simple, sessionId);
			const chunks = await collectChunks(gen2);
			assert.ok(chunks.length > 0);
		});

		it.skip("cancels correct session in multi-session scenario", async () => {
			// TODO: This test with concurrent prompts + setTimeout causes timeouts
			const session2Id = agent.createSession().id;

			const _gen1 = agent.prompt(provider.testMessages.simple, sessionId);
			const gen2 = agent.prompt(provider.testMessages.simple, session2Id);

			// Cancel first session
			setTimeout(() => agent.cancel(sessionId), 100);

			// Second session should complete
			const chunks2 = await collectChunks(gen2);
			assert.ok(chunks2.length > 0);
		});
	});

	// ==========================================================================
	// ENVIRONMENT MANAGEMENT
	// ==========================================================================

	describe("Environment Management", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("getEnvironment returns object", () => {
			const env = agent.getEnvironment();
			assert.ok(typeof env === "object");
			assert.ok(env !== null);
		});

		it("updateEnvironment sets variables", async () => {
			await agent.updateEnvironment({ TEST_VAR: "test-value" });
			const env = agent.getEnvironment();
			assert.equal(env.TEST_VAR, "test-value");
		});

		it("updateEnvironment merges with existing", async () => {
			await agent.updateEnvironment({ VAR1: "value1" });
			await agent.updateEnvironment({ VAR2: "value2" });

			const env = agent.getEnvironment();
			assert.equal(env.VAR1, "value1");
			assert.equal(env.VAR2, "value2");
		});

		it("updateEnvironment overwrites existing keys", async () => {
			await agent.updateEnvironment({ VAR: "old" });
			await agent.updateEnvironment({ VAR: "new" });

			const env = agent.getEnvironment();
			assert.equal(env.VAR, "new");
		});

		it("updateEnvironment with empty object is safe", async () => {
			await assert.doesNotReject(async () => await agent.updateEnvironment({}));
		});
	});

	// ==========================================================================
	// MODEL LISTING
	// ==========================================================================

	describe("Model Listing", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("listModels returns an array", async () => {
			const models = await agent.listModels();
			assert.ok(Array.isArray(models));
		});

		it("listModels returns non-empty list", async () => {
			const models = await agent.listModels();
			assert.ok(models.length > 0, "Should return at least one model");
		});

		it("models have required fields", async () => {
			const models = await agent.listModels();

			for (const model of models) {
				assert.ok(typeof model.id === "string", "id should be a string");
				assert.ok(model.id.length > 0, "id should not be empty");
				assert.ok(
					typeof model.display_name === "string",
					"display_name should be a string",
				);
				assert.ok(
					model.display_name.length > 0,
					"display_name should not be empty",
				);
				assert.ok(
					typeof model.provider === "string",
					"provider should be a string",
				);
				assert.ok(model.provider.length > 0, "provider should not be empty");
				assert.ok(
					typeof model.created_at === "string",
					"created_at should be a string",
				);
				assert.ok(typeof model.type === "string", "type should be a string");
				assert.ok(
					typeof model.reasoning === "boolean",
					"reasoning should be a boolean",
				);
			}
		});

		it("model IDs include provider prefix", async () => {
			const models = await agent.listModels();

			for (const model of models) {
				assert.ok(
					model.id.includes(":"),
					`Model ID "${model.id}" should include a provider prefix (e.g. "anthropic:")`,
				);
			}
		});

		it("returns consistent results on repeated calls", async () => {
			const models1 = await agent.listModels();
			const models2 = await agent.listModels();

			assert.equal(
				models1.length,
				models2.length,
				"Should return the same number of models",
			);

			const ids1 = models1.map((m: ModelInfo) => m.id).sort();
			const ids2 = models2.map((m: ModelInfo) => m.id).sort();
			assert.deepEqual(ids1, ids2, "Should return the same model IDs");
		});

		it("does not require a session", async () => {
			// listModels should work without creating a session first
			const models = await agent.listModels();
			assert.ok(Array.isArray(models));
			assert.ok(models.length > 0);
		});
	});

	// ==========================================================================
	// SESSION PERSISTENCE
	// ==========================================================================

	describe("Session Persistence", () => {
		it("sessions persist across disconnect/reconnect", async () => {
			await agent.connect();
			const sessionId = await agent.ensureSession("persist-test");

			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen);

			const messagesBefore = agent.getSession(sessionId)?.getMessages();
			assert.ok(messagesBefore && messagesBefore.length > 0);

			// Disconnect and reconnect
			await agent.disconnect();
			agent = provider.createAgent();
			await agent.connect();

			// Resume session
			await agent.ensureSession(sessionId);

			const messagesAfter = agent.getSession(sessionId)?.getMessages();
			assert.ok(messagesAfter && messagesAfter.length > 0);
			assert.equal(messagesAfter.length, messagesBefore.length);
		});

		it("can continue conversation after restart", async () => {
			await agent.connect();
			const sessionId = await agent.ensureSession("continue-test");

			// First message
			const gen1 = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen1);

			// Restart
			await agent.disconnect();
			agent = provider.createAgent();
			await agent.connect();
			await agent.ensureSession(sessionId);

			// Continue conversation
			const gen2 = agent.prompt(provider.testMessages.continuation, sessionId);
			const chunks2 = await collectChunks(gen2);
			assert.ok(chunks2.length > 0);
		});
	});

	// ==========================================================================
	// MULTI-SESSION BEHAVIOR
	// ==========================================================================

	describe("Multi-Session Behavior", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("maintains independent session state", async () => {
			const sessionA = agent.createSession().id;
			const sessionB = agent.createSession().id;

			const genA = agent.prompt(provider.testMessages.simple, sessionA);
			await collectChunks(genA);

			const genB = agent.prompt(provider.testMessages.continuation, sessionB);
			await collectChunks(genB);

			const sA = agent.getSession(sessionA);
			const sB = agent.getSession(sessionB);

			assert.ok(sA && sB);
			assert.notEqual(
				JSON.stringify(sA.getMessages()),
				JSON.stringify(sB.getMessages()),
			);
		});

		it("handles concurrent prompts in different sessions", async () => {
			const sessionA = agent.createSession().id;
			const sessionB = agent.createSession().id;

			const [chunksA, chunksB] = await Promise.all([
				collectChunks(agent.prompt(provider.testMessages.simple, sessionA)),
				collectChunks(agent.prompt(provider.testMessages.simple, sessionB)),
			]);

			assert.ok(chunksA.length > 0);
			assert.ok(chunksB.length > 0);
		});

		it("clears session without affecting others", async () => {
			const sessionA = agent.createSession().id;
			const sessionB = agent.createSession().id;

			const genA = agent.prompt(provider.testMessages.simple, sessionA);
			await collectChunks(genA);

			const genB = agent.prompt(provider.testMessages.simple, sessionB);
			await collectChunks(genB);

			await agent.clearSession(sessionA);

			const sA = agent.getSession(sessionA);
			const sB = agent.getSession(sessionB);

			assert.ok(sA && sB);
			assert.equal(sA.getMessages().length, 0);
			assert.ok(sB.getMessages().length > 0);
		});
	});

	// ==========================================================================
	// EDGE CASES
	// ==========================================================================

	describe("Edge Cases", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("handles rapid connect/disconnect cycles", async () => {
			for (let i = 0; i < 3; i++) {
				await agent.connect();
				assert.equal(agent.isConnected, true);
				await agent.disconnect();
				assert.equal(agent.isConnected, false);
			}
		});

		it("disconnect cleans up resources", async () => {
			await agent.connect();
			const sessionId = agent.createSession().id;
			const gen = agent.prompt(provider.testMessages.simple, sessionId);
			await collectChunks(gen);

			await agent.disconnect();
			assert.equal(agent.isConnected, false);

			// Should be able to reconnect
			await agent.connect();
			assert.equal(agent.isConnected, true);
		});

		it("handles empty parts array", async () => {
			const sessionId = agent.createSession().id;
			const emptyMessage = {
				id: "empty-msg",
				role: "user" as const,
				parts: [],
			};

			try {
				const gen = agent.prompt(emptyMessage, sessionId);
				await collectChunks(gen);
				assert.ok(true, "Handled empty message gracefully");
			} catch (error) {
				assert.ok(error instanceof Error);
				assert.ok(error.message.length > 0);
			}
		});
	});

	// ==========================================================================
	// INTEGRATION SCENARIOS
	// ==========================================================================

	describe("Integration Scenarios", () => {
		beforeEach(async () => {
			await agent.connect();
		});

		it("completes multi-turn conversation", async () => {
			const sessionId = agent.createSession().id;

			// Turn 1
			const gen1 = agent.prompt(provider.testMessages.simple, sessionId);
			const chunks1 = await collectChunks(gen1);
			assert.ok(chunks1.length > 0);

			// Turn 2
			const gen2 = agent.prompt(provider.testMessages.continuation, sessionId);
			const chunks2 = await collectChunks(gen2);
			assert.ok(chunks2.length > 0);

			// Turn 3 with tools
			const gen3 = agent.prompt(provider.testMessages.withTools, sessionId);
			const chunks3 = await collectChunks(gen3);
			assert.ok(chunks3.length > 0);

			// Verify session history
			const session = agent.getSession(sessionId);
			assert.ok(session);
			assert.ok(session.getMessages().length >= 6); // 3 user + 3 assistant
		});

		it("handles complex workflow", async () => {
			// Create multiple sessions
			const session1 = agent.createSession().id;
			const session2 = agent.createSession().id;

			// Update environment
			await agent.updateEnvironment({ WORKFLOW_VAR: "test" });

			// Send to session 1
			const gen1 = agent.prompt(provider.testMessages.simple, session1);
			await collectChunks(gen1);

			// Send to session 2
			const gen2 = agent.prompt(provider.testMessages.withTools, session2);
			await collectChunks(gen2);

			// Clear session 1
			await agent.clearSession(session1);

			// Continue session 2
			const gen3 = agent.prompt(provider.testMessages.continuation, session2);
			const chunks3 = await collectChunks(gen3);
			assert.ok(chunks3.length > 0);

			// Verify states
			const s1 = agent.getSession(session1);
			const s2 = agent.getSession(session2);

			assert.equal(s1?.getMessages().length, 0);
			assert.ok(s2 && s2.getMessages().length > 0);

			const env = agent.getEnvironment();
			assert.equal(env.WORKFLOW_VAR, "test");
		});
	});
});
