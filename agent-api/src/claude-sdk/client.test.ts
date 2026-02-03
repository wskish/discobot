import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { UIMessage } from "ai";
import { ClaudeSDKClient } from "./client.js";

describe("ClaudeSDKClient", () => {
	let client: ClaudeSDKClient;

	beforeEach(() => {
		client = new ClaudeSDKClient({
			cwd: "/home/user/workspace",
			model: "claude-sonnet-4-5-20250929",
			env: { TEST_VAR: "test" },
		});
	});

	describe("constructor", () => {
		it("initializes with provided options", () => {
			const client = new ClaudeSDKClient({
				cwd: "/test/path",
				model: "claude-opus-4-5-20251101",
				env: { FOO: "bar" },
			});

			const env = client.getEnvironment();
			assert.strictEqual(env.FOO, "bar");
		});

		it("copies environment to avoid mutations", () => {
			const originalEnv = { FOO: "bar" };
			const client = new ClaudeSDKClient({
				cwd: "/test",
				env: originalEnv,
			});

			const env = client.getEnvironment();
			env.FOO = "mutated";

			// Original should be unchanged
			assert.strictEqual(originalEnv.FOO, "bar");
		});
	});

	describe("connect/disconnect", () => {
		it("tracks connection state correctly", async () => {
			// Should start disconnected
			assert.strictEqual(client.isConnected, false);

			// Should be connected after connect()
			await client.connect();
			assert.strictEqual(client.isConnected, true);

			// Should be disconnected after disconnect()
			await client.disconnect();
			assert.strictEqual(client.isConnected, false);
		});

		it("disconnect clears sessions", async () => {
			await client.connect();
			await client.ensureSession("test-session");
			assert.strictEqual(client.listSessions().length, 1);

			await client.disconnect();
			assert.strictEqual(client.listSessions().length, 0);
		});
	});

	describe("ensureSession", () => {
		it("creates new session if it does not exist", async () => {
			const sessionId = await client.ensureSession("new-session");

			assert.strictEqual(sessionId, "new-session");
			assert.ok(client.getSession("new-session"));
		});

		it("reuses existing session", async () => {
			const sessionId1 = await client.ensureSession("test-session");
			const session1 = client.getSession("test-session");

			const sessionId2 = await client.ensureSession("test-session");
			const session2 = client.getSession("test-session");

			assert.strictEqual(sessionId1, sessionId2);
			assert.strictEqual(session1, session2);
		});

		it("uses default session when no id provided", async () => {
			const sessionId = await client.ensureSession();

			assert.strictEqual(sessionId, "default");
			assert.ok(client.getSession());
		});

		it("sets current session id", async () => {
			await client.ensureSession("session-1");
			assert.strictEqual(client.listSessions().length, 1);

			const session = client.getSession(); // No id = current
			assert.ok(session);
		});
	});

	describe("session management", () => {
		it("listSessions returns all session ids", async () => {
			await client.ensureSession("session-1");
			await client.ensureSession("session-2");
			await client.ensureSession("session-3");

			const sessions = client.listSessions();
			assert.strictEqual(sessions.length, 3);
			assert.ok(sessions.includes("session-1"));
			assert.ok(sessions.includes("session-2"));
			assert.ok(sessions.includes("session-3"));
		});

		it("createSession creates new session", () => {
			const session = client.createSession("manual-session");

			assert.ok(session);
			assert.ok(client.listSessions().includes("manual-session"));
		});

		it("getSession returns undefined for non-existent session", () => {
			const session = client.getSession("nonexistent");
			assert.strictEqual(session, undefined);
		});

		it("clearSession removes messages but keeps session", async () => {
			await client.ensureSession("test");
			client.addMessage({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Test" }],
			});

			assert.strictEqual(client.getMessages().length, 1);

			await client.clearSession("test");

			// Session still exists
			assert.ok(client.getSession("test"));
			// But messages are cleared
			assert.strictEqual(
				client.getSession("test")?.getMessages().length || 0,
				0,
			);
		});
	});

	describe("environment management", () => {
		it("updateEnvironment merges new values", async () => {
			await client.updateEnvironment({
				env: { NEW_VAR: "new_value" },
			});

			const env = client.getEnvironment();
			assert.strictEqual(env.TEST_VAR, "test"); // Original preserved
			assert.strictEqual(env.NEW_VAR, "new_value"); // New added
		});

		it("updateEnvironment overwrites existing values", async () => {
			await client.updateEnvironment({
				env: { TEST_VAR: "updated" },
			});

			const env = client.getEnvironment();
			assert.strictEqual(env.TEST_VAR, "updated");
		});

		it("getEnvironment returns copy", () => {
			const env1 = client.getEnvironment();
			env1.MUTATED = "value";

			const env2 = client.getEnvironment();
			assert.strictEqual(env2.MUTATED, undefined);
		});
	});

	describe("message management", () => {
		beforeEach(async () => {
			await client.ensureSession();
		});

		it("addMessage adds to current session", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Hello" }],
			};

			client.addMessage(message);

			const messages = client.getMessages();
			assert.strictEqual(messages.length, 1);
			assert.strictEqual(messages[0].id, "msg-1");
		});

		it("updateMessage modifies existing message", () => {
			client.addMessage({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Original" }],
			});

			client.updateMessage("msg-1", {
				parts: [{ type: "text", text: "Updated" }],
			});

			const messages = client.getMessages();
			assert.strictEqual((messages[0].parts[0] as any).text, "Updated");
		});

		it("getLastAssistantMessage returns most recent assistant message", () => {
			client.addMessage({
				id: "user-1",
				role: "user",
				parts: [{ type: "text", text: "Question" }],
			});

			client.addMessage({
				id: "asst-1",
				role: "assistant",
				parts: [{ type: "text", text: "Answer 1" }],
			});

			client.addMessage({
				id: "user-2",
				role: "user",
				parts: [{ type: "text", text: "Follow-up" }],
			});

			client.addMessage({
				id: "asst-2",
				role: "assistant",
				parts: [{ type: "text", text: "Answer 2" }],
			});

			const lastAssistant = client.getLastAssistantMessage();
			assert.strictEqual(lastAssistant?.id, "asst-2");
		});

		it("clearMessages removes all messages", () => {
			client.addMessage({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Test" }],
			});
			client.addMessage({
				id: "msg-2",
				role: "user",
				parts: [{ type: "text", text: "Test 2" }],
			});

			assert.strictEqual(client.getMessages().length, 2);

			client.clearMessages();

			assert.strictEqual(client.getMessages().length, 0);
		});

		it("supports multiple independent sessions", async () => {
			await client.ensureSession("session-1");
			client.addMessage({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Session 1 message" }],
			});

			await client.ensureSession("session-2");
			client.addMessage({
				id: "msg-2",
				role: "user",
				parts: [{ type: "text", text: "Session 2 message" }],
			});

			// Session 1 should have 1 message
			const session1Messages =
				client.getSession("session-1")?.getMessages() || [];
			assert.strictEqual(session1Messages.length, 1);
			assert.strictEqual(session1Messages[0].id, "msg-1");

			// Session 2 should have 1 message
			const session2Messages =
				client.getSession("session-2")?.getMessages() || [];
			assert.strictEqual(session2Messages.length, 1);
			assert.strictEqual(session2Messages[0].id, "msg-2");
		});
	});

	describe("setUpdateCallback", () => {
		it("can set and clear callbacks", async () => {
			await client.ensureSession("test");

			const callback = () => {};
			client.setUpdateCallback(callback);

			// Can clear by passing null
			client.setUpdateCallback(null);

			// Should not throw
		});

		it("sets callback for specific session", async () => {
			await client.ensureSession("session-1");
			await client.ensureSession("session-2");

			const callback1 = () => {};
			const callback2 = () => {};

			client.setUpdateCallback(callback1, "session-1");
			client.setUpdateCallback(callback2, "session-2");

			// Callbacks are set independently per session
			// Should not throw
		});
	});

	describe("cancel", () => {
		it("cancel is a no-op", async () => {
			await client.cancel();
			// Should not throw
		});

		it("cancel with session id is a no-op", async () => {
			await client.ensureSession("test");
			await client.cancel("test");
			// Should not throw
		});
	});

	// Note: Tests for prompt(), discoverAvailableSessions(), and loadFullSession()
	// require actual SDK integration or complex mocking. These should be tested
	// in integration tests where we can use real session files and SDK responses.
	// See test/integration/ for these tests.
});
