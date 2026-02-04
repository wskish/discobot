import assert from "node:assert";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { DynamicToolUIPart } from "ai";
import {
	clearSession as clearStoredSession,
	getSessionData,
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

		it("clearSession clears session state but keeps session object", async () => {
			await client.ensureSession("test");

			await client.clearSession("test");

			// Session object still exists
			assert.ok(client.getSession("test"));
			// Messages should be empty
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

	describe("session independence", () => {
		it("sessions are independent", async () => {
			await client.ensureSession("session-1");
			await client.ensureSession("session-2");

			// Each session has its own (empty) message store
			const session1Messages =
				client.getSession("session-1")?.getMessages() || [];
			const session2Messages =
				client.getSession("session-2")?.getMessages() || [];

			assert.strictEqual(session1Messages.length, 0);
			assert.strictEqual(session2Messages.length, 0);
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

describe("ClaudeSDKClient session restoration after restart", () => {
	// This test simulates an agent-api restart scenario where:
	// 1. A session existed with messages before restart
	// 2. After restart, GET /chat should find and return those messages
	//
	// The test creates the necessary files that Claude SDK would have created:
	// - ~/.config/discobot/agent-session.json (sessionId -> claudeSessionId mapping)
	// - ~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl (actual messages)

	const TEST_DATA_DIR = join(tmpdir(), `discobot-restart-test-${process.pid}`);
	const CLAUDE_PROJECTS_DIR = join(TEST_DATA_DIR, ".claude", "projects");
	const CONFIG_DIR = join(TEST_DATA_DIR, ".config", "discobot");
	const testSessionFile = join(CONFIG_DIR, "agent-session.json");
	const testMessagesFile = join(CONFIG_DIR, "agent-messages.json");

	// Test workspace path - we encode this for the Claude projects dir
	const TEST_CWD = "/home/testuser/myproject";
	const ENCODED_CWD = "-home-testuser-myproject";
	const CLAUDE_SESSION_ID = "test-claude-session-uuid-123";
	const DISCOBOT_SESSION_ID = "my-discobot-session";

	before(() => {
		// Create test directories
		mkdirSync(join(CLAUDE_PROJECTS_DIR, ENCODED_CWD), { recursive: true });
		mkdirSync(CONFIG_DIR, { recursive: true });

		// Set env vars to use test files
		process.env.SESSION_FILE = testSessionFile;
		process.env.MESSAGES_FILE = testMessagesFile;
		process.env.HOME = TEST_DATA_DIR;
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
		// Remove Claude session file if exists
		const claudeSessionFile = join(
			CLAUDE_PROJECTS_DIR,
			ENCODED_CWD,
			`${CLAUDE_SESSION_ID}.jsonl`,
		);
		if (existsSync(claudeSessionFile)) {
			rmSync(claudeSessionFile);
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
		delete process.env.HOME;
	});

	/**
	 * Create a Claude SDK session file in JSONL format with test messages.
	 * This simulates what Claude SDK writes during a conversation.
	 */
	async function createClaudeSessionFile(
		claudeSessionId: string,
		messages: Array<{ type: string; uuid: string; message: unknown }>,
	): Promise<void> {
		const sessionFile = join(
			CLAUDE_PROJECTS_DIR,
			ENCODED_CWD,
			`${claudeSessionId}.jsonl`,
		);
		const lines = messages.map((m) => JSON.stringify(m));
		const { writeFile: writeFileAsync } = await import("node:fs/promises");
		await writeFileAsync(sessionFile, lines.join("\n"), "utf-8");
	}

	it("restores messages after restart when claudeSessionId mapping exists", async () => {
		// Step 1: Create a Claude session file with messages (simulating previous session)
		await createClaudeSessionFile(CLAUDE_SESSION_ID, [
			{
				type: "user",
				uuid: "user-msg-1",
				message: {
					role: "user",
					content: "Hello, how are you?",
				},
			},
			{
				type: "assistant",
				uuid: "asst-msg-1",
				message: {
					id: "asst-msg-1",
					role: "assistant",
					content: [{ type: "text", text: "I am doing well, thank you!" }],
				},
			},
		]);

		// Step 2: Create the sessionId -> claudeSessionId mapping
		await saveSession({
			sessionId: DISCOBOT_SESSION_ID,
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: CLAUDE_SESSION_ID,
		});

		// Step 3: Create a new client (simulating restart)
		const client = new ClaudeSDKClient({
			cwd: TEST_CWD,
		});

		// Step 4: Call ensureSession (this is what GET /chat does)
		await client.ensureSession(DISCOBOT_SESSION_ID);

		// Step 5: Get the session and verify messages are loaded
		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist after ensureSession");

		const messages = session.getMessages();
		assert.strictEqual(
			messages.length,
			2,
			"Should have restored 2 messages from disk",
		);

		// Verify user message
		const userMsg = messages.find((m) => m.role === "user");
		assert.ok(userMsg, "User message should be present");
		assert.strictEqual(userMsg.id, "user-msg-1");

		// Verify assistant message
		const asstMsg = messages.find((m) => m.role === "assistant");
		assert.ok(asstMsg, "Assistant message should be present");
		assert.strictEqual(asstMsg.id, "asst-msg-1");
	});

	it("returns empty messages when no claudeSessionId mapping exists", async () => {
		// No mapping file exists - simulating a new session or corrupted state

		// Create a new client
		const client = new ClaudeSDKClient({
			cwd: TEST_CWD,
		});

		// Call ensureSession
		await client.ensureSession(DISCOBOT_SESSION_ID);

		// Get the session
		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");

		// Should have no messages
		const messages = session.getMessages();
		assert.strictEqual(
			messages.length,
			0,
			"Should have no messages without claudeSessionId mapping",
		);
	});

	it("returns empty messages when Claude session file does not exist", async () => {
		// Create the mapping but not the actual session file
		await saveSession({
			sessionId: DISCOBOT_SESSION_ID,
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: "non-existent-session-id",
		});

		// Create a new client
		const client = new ClaudeSDKClient({
			cwd: TEST_CWD,
		});

		// Call ensureSession - should not throw
		await client.ensureSession(DISCOBOT_SESSION_ID);

		// Get the session
		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");

		// Should have no messages (file doesn't exist)
		const messages = session.getMessages();
		assert.strictEqual(
			messages.length,
			0,
			"Should have no messages when Claude session file is missing",
		);
	});

	it("does not restore messages for a different session ID", async () => {
		// Create a Claude session file with messages
		await createClaudeSessionFile(CLAUDE_SESSION_ID, [
			{
				type: "user",
				uuid: "user-msg-1",
				message: { role: "user", content: "Hello" },
			},
		]);

		// Create mapping for a different session ID
		await saveSession({
			sessionId: "different-session",
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: CLAUDE_SESSION_ID,
		});

		// Create a new client
		const client = new ClaudeSDKClient({
			cwd: TEST_CWD,
		});

		// Ensure the wrong session ID
		await client.ensureSession(DISCOBOT_SESSION_ID);

		// Get the session
		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");

		// Should have no messages (session ID doesn't match)
		const messages = session.getMessages();
		assert.strictEqual(
			messages.length,
			0,
			"Should not load messages for different session ID",
		);
	});

	it("restores messages with tool calls after restart", async () => {
		// Create a session with tool calls
		await createClaudeSessionFile(CLAUDE_SESSION_ID, [
			{
				type: "user",
				uuid: "user-msg-1",
				message: { role: "user", content: "List files in current directory" },
			},
			{
				type: "assistant",
				uuid: "asst-msg-1",
				message: {
					id: "asst-msg-1",
					role: "assistant",
					content: [
						{ type: "text", text: "Let me list the files for you." },
						{
							type: "tool_use",
							id: "tool-1",
							name: "Bash",
							input: { command: "ls -la" },
						},
					],
				},
			},
			{
				type: "user",
				uuid: "user-msg-2",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-1",
							content: "file1.txt\nfile2.txt",
						},
					],
				},
			},
		]);

		// Create the mapping
		await saveSession({
			sessionId: DISCOBOT_SESSION_ID,
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: CLAUDE_SESSION_ID,
		});

		// Create a new client
		const client = new ClaudeSDKClient({
			cwd: TEST_CWD,
		});

		// Ensure session
		await client.ensureSession(DISCOBOT_SESSION_ID);

		// Get messages
		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");
		const messages = session.getMessages();

		// Should have restored messages
		assert.ok(messages.length >= 2, "Should have restored messages");

		// Find assistant message with tool call
		const asstMsg = messages.find((m) => m.role === "assistant");
		assert.ok(asstMsg, "Should have assistant message");

		// Check for tool part
		const toolPart = asstMsg.parts.find((p) => p.type === "dynamic-tool") as
			| DynamicToolUIPart
			| undefined;
		assert.ok(toolPart, "Should have tool part in assistant message");
		assert.strictEqual(toolPart.toolName, "Bash");
		assert.strictEqual(toolPart.toolCallId, "tool-1");
	});

	it("restores tool outputs merged into tool parts", async () => {
		// Create a session with tool call AND tool result
		// This tests the fix for tool outputs not being merged when loading from disk
		await createClaudeSessionFile(CLAUDE_SESSION_ID, [
			{
				type: "user",
				uuid: "user-msg-1",
				message: { role: "user", content: "What files are here?" },
			},
			{
				type: "assistant",
				uuid: "asst-msg-1",
				message: {
					id: "msg-1",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-abc",
							name: "Bash",
							input: { command: "ls" },
						},
					],
				},
			},
			{
				// Tool result comes as a user message with no text content
				type: "user",
				uuid: "user-msg-2",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-abc",
							content: "file1.txt\nfile2.txt\nfile3.txt",
						},
					],
				},
			},
			{
				// Assistant continues after tool result
				type: "assistant",
				uuid: "asst-msg-2",
				message: {
					id: "msg-2",
					role: "assistant",
					content: [{ type: "text", text: "I found 3 files." }],
				},
			},
		]);

		// Create the mapping
		await saveSession({
			sessionId: DISCOBOT_SESSION_ID,
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: CLAUDE_SESSION_ID,
		});

		// Create a new client and load session
		const client = new ClaudeSDKClient({ cwd: TEST_CWD });
		await client.ensureSession(DISCOBOT_SESSION_ID);

		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");
		const messages = session.getMessages();

		// Find the assistant message (should be merged into one)
		const asstMsg = messages.find((m) => m.role === "assistant");
		assert.ok(asstMsg, "Should have assistant message");

		// Find the tool part
		const toolPart = asstMsg.parts.find((p) => p.type === "dynamic-tool") as
			| DynamicToolUIPart
			| undefined;
		assert.ok(toolPart, "Should have tool part");

		// THE KEY ASSERTION: Tool output should be merged into the part
		assert.strictEqual(
			toolPart.state,
			"output-available",
			"Tool part should have output-available state",
		);
		assert.strictEqual(
			toolPart.output,
			"file1.txt\nfile2.txt\nfile3.txt",
			"Tool output should be merged into the part",
		);
	});

	it("restores tool error state when tool result has is_error", async () => {
		await createClaudeSessionFile(CLAUDE_SESSION_ID, [
			{
				type: "user",
				uuid: "user-msg-1",
				message: { role: "user", content: "Delete all files" },
			},
			{
				type: "assistant",
				uuid: "asst-msg-1",
				message: {
					id: "msg-1",
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "tool-err",
							name: "Bash",
							input: { command: "rm -rf /" },
						},
					],
				},
			},
			{
				type: "user",
				uuid: "user-msg-2",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "tool-err",
							content: "Permission denied",
							is_error: true,
						},
					],
				},
			},
		]);

		await saveSession({
			sessionId: DISCOBOT_SESSION_ID,
			cwd: TEST_CWD,
			createdAt: new Date().toISOString(),
			claudeSessionId: CLAUDE_SESSION_ID,
		});

		const client = new ClaudeSDKClient({ cwd: TEST_CWD });
		await client.ensureSession(DISCOBOT_SESSION_ID);

		const session = client.getSession(DISCOBOT_SESSION_ID);
		assert.ok(session, "Session should exist");
		const messages = session.getMessages();
		const asstMsg = messages.find((m) => m.role === "assistant");
		assert.ok(asstMsg, "Should have assistant message");
		const toolPart = asstMsg.parts.find((p) => p.type === "dynamic-tool") as
			| DynamicToolUIPart
			| undefined;
		assert.ok(toolPart, "Should have tool part");

		assert.strictEqual(
			toolPart.state,
			"output-error",
			"Tool part should have output-error state",
		);
		assert.strictEqual(
			toolPart.errorText,
			"Permission denied",
			"Tool error text should be set",
		);
	});
});
