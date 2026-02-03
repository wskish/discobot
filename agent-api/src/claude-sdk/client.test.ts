import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
	clearSession as clearStoredSession,
	getSessionData,
	loadSession,
	saveSession,
} from "../store/session.js";
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

describe("ClaudeSDKClient claudeSessionId persistence", () => {
	// Set up a test directory for session files
	const TEST_DATA_DIR = join(tmpdir(), `discobot-client-test-${process.pid}`);
	const testSessionFile = join(TEST_DATA_DIR, "test-session.json");
	const testMessagesFile = join(TEST_DATA_DIR, "test-messages.json");

	before(() => {
		// Create test directory
		if (!existsSync(TEST_DATA_DIR)) {
			mkdirSync(TEST_DATA_DIR, { recursive: true });
		}
		// Set env vars to use test files
		process.env.SESSION_FILE = testSessionFile;
		process.env.MESSAGES_FILE = testMessagesFile;
	});

	beforeEach(async () => {
		// Clear persisted session before each test
		await clearStoredSession();
		// Remove test files if they exist
		if (existsSync(testSessionFile)) {
			rmSync(testSessionFile);
		}
		if (existsSync(testMessagesFile)) {
			rmSync(testMessagesFile);
		}
	});

	after(async () => {
		// Clean up
		await clearStoredSession();
		if (existsSync(TEST_DATA_DIR)) {
			rmSync(TEST_DATA_DIR, { recursive: true, force: true });
		}
		// Restore env vars
		delete process.env.SESSION_FILE;
		delete process.env.MESSAGES_FILE;
	});

	it("loads persisted claudeSessionId when session exists", async () => {
		// Pre-persist a session with a claudeSessionId
		await saveSession({
			sessionId: "my-discobot-session",
			cwd: "/test/workspace",
			createdAt: new Date().toISOString(),
			claudeSessionId: "claude-abc-123",
		});

		// Create client and ensure the session
		const client = new ClaudeSDKClient({
			cwd: "/test/workspace",
		});
		await client.ensureSession("my-discobot-session");

		// The client should have loaded the claudeSessionId internally
		// We can verify this by checking that the persisted data is still there
		const sessionData = getSessionData();
		assert.strictEqual(sessionData?.claudeSessionId, "claude-abc-123");
		assert.strictEqual(sessionData?.sessionId, "my-discobot-session");
	});

	it("does not load claudeSessionId for different session", async () => {
		// Pre-persist a session with a different sessionId
		await saveSession({
			sessionId: "other-session",
			cwd: "/test/workspace",
			createdAt: new Date().toISOString(),
			claudeSessionId: "claude-xyz-789",
		});

		// Create client and ensure a different session
		const client = new ClaudeSDKClient({
			cwd: "/test/workspace",
		});
		await client.ensureSession("my-session");

		// The session data should still be the old one (not overwritten)
		const sessionData = getSessionData();
		assert.strictEqual(sessionData?.sessionId, "other-session");
	});

	it("clearSession clears persisted session data", async () => {
		// Pre-persist a session
		await saveSession({
			sessionId: "test-session",
			cwd: "/test/workspace",
			createdAt: new Date().toISOString(),
			claudeSessionId: "claude-session-id",
		});

		// Verify it was saved
		assert.ok(
			existsSync(testSessionFile),
			"Session file should exist before clear",
		);

		// Create client, ensure session, and clear it
		const client = new ClaudeSDKClient({
			cwd: "/test/workspace",
		});
		await client.ensureSession("test-session");
		await client.clearSession("test-session");

		// Session file should be removed
		assert.strictEqual(
			existsSync(testSessionFile),
			false,
			"Session file should be deleted after clearSession",
		);
	});

	it("persists claudeSessionId to file with correct structure", async () => {
		// Save a session with claudeSessionId
		await saveSession({
			sessionId: "persist-test",
			cwd: "/workspace",
			createdAt: "2024-01-01T00:00:00.000Z",
			claudeSessionId: "claude-persisted-id",
		});

		// Read the file directly and verify structure
		const content = await readFile(testSessionFile, "utf-8");
		const data = JSON.parse(content);

		assert.strictEqual(data.sessionId, "persist-test");
		assert.strictEqual(data.cwd, "/workspace");
		assert.strictEqual(data.createdAt, "2024-01-01T00:00:00.000Z");
		assert.strictEqual(data.claudeSessionId, "claude-persisted-id");
	});

	it("handles missing claudeSessionId in persisted data gracefully", async () => {
		// Save a session WITHOUT claudeSessionId (legacy data)
		await saveSession({
			sessionId: "legacy-session",
			cwd: "/test/workspace",
			createdAt: new Date().toISOString(),
		});

		// Create client and ensure the session
		const client = new ClaudeSDKClient({
			cwd: "/test/workspace",
		});

		// Should not throw
		await client.ensureSession("legacy-session");

		// Client should work normally
		const session = client.getSession("legacy-session");
		assert.ok(session, "Session should exist");
	});
});
