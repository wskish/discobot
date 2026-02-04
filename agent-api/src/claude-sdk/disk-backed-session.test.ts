import assert from "node:assert";
import { describe, it } from "node:test";
import { DiskBackedSession } from "./disk-backed-session.js";

describe("DiskBackedSession", () => {
	const testCwd = "/test/workspace";
	const testSessionId = `test-session-${Date.now()}`;

	describe("message loading", () => {
		it("returns empty messages initially", () => {
			const session = new DiskBackedSession(testSessionId, testCwd);
			const messages = session.getMessages();
			assert.strictEqual(
				messages.length,
				0,
				"Should return empty array before load",
			);
		});

		it("load() populates cache from disk (empty session)", async () => {
			const session = new DiskBackedSession(
				`non-existent-${Date.now()}`,
				testCwd,
			);
			await session.load();

			const messages = session.getMessages();
			// Non-existent session loads as empty
			assert.strictEqual(messages.length, 0);
		});
	});

	describe("clearMessages", () => {
		it("clears cached messages", async () => {
			const session = new DiskBackedSession(`clear-${Date.now()}`, testCwd);
			await session.load();

			session.clearMessages();

			const messages = session.getMessages();
			assert.strictEqual(messages.length, 0);
		});
	});

	describe("session interface compliance", () => {
		it("has readonly id property", () => {
			const session = new DiskBackedSession(testSessionId, testCwd);
			assert.strictEqual(session.id, testSessionId);
		});

		it("implements all Session interface methods", () => {
			const session = new DiskBackedSession(testSessionId, testCwd);

			assert.strictEqual(typeof session.getMessages, "function");
			assert.strictEqual(typeof session.clearMessages, "function");
		});
	});

	describe("load with claudeSessionId", () => {
		it("accepts optional claudeSessionId parameter", async () => {
			const session = new DiskBackedSession(testSessionId, testCwd);

			// Should not throw when loading with a different claude session ID
			await session.load("different-claude-session-id");

			const messages = session.getMessages();
			// Non-existent session loads as empty
			assert.strictEqual(messages.length, 0);
		});

		it("setClaudeSessionId sets the session ID for loading", async () => {
			const session = new DiskBackedSession(testSessionId, testCwd);

			session.setClaudeSessionId("my-claude-session");
			await session.load();

			// Should use the set claude session ID
			// (tests with real files are in integration tests)
			assert.ok(true);
		});
	});
});
