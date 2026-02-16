import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	getLastMessageError,
	getSessionDirectoryForCwd,
} from "./persistence.js";

describe("persistence", () => {
	describe("getSessionDirectoryForCwd", () => {
		it("encodes cwd path correctly", () => {
			const cwd = "/home/user/workspace";
			const result = getSessionDirectoryForCwd(cwd);

			// Should remove leading slash and replace remaining slashes with dashes
			assert.ok(result.includes("home-user-workspace"));
			assert.ok(result.includes(".claude/projects"));
		});

		it("handles root directory", () => {
			const cwd = "/";
			const result = getSessionDirectoryForCwd(cwd);

			// Root should become empty string after removing leading slash
			assert.ok(result.includes(".claude/projects"));
		});

		it("handles nested paths", () => {
			const cwd = "/var/www/html/project";
			const result = getSessionDirectoryForCwd(cwd);

			assert.ok(result.includes("var-www-html-project"));
		});

		it("handles paths with multiple levels", () => {
			const cwd = "/a/b/c/d/e";
			const result = getSessionDirectoryForCwd(cwd);

			assert.ok(result.includes("a-b-c-d-e"));
			assert.ok(!result.includes("//"));
			assert.ok(!result.startsWith("-"));
		});

		it("produces consistent results", () => {
			const cwd = "/home/user/workspace";
			const result1 = getSessionDirectoryForCwd(cwd);
			const result2 = getSessionDirectoryForCwd(cwd);

			assert.strictEqual(result1, result2);
		});
	});

	describe("getLastMessageError", () => {
		// Create a test directory for JSONL files
		const testDir = join(tmpdir(), `claude-test-${Date.now()}`);
		const testCwd = join(testDir, "workspace");
		// Use getSessionDirectoryForCwd to get the correct encoded path
		const sessionDir = getSessionDirectoryForCwd(testCwd);

		// Helper to write test session file
		const writeTestSession = async (sessionId: string, messages: unknown[]) => {
			const content = messages.map((msg) => JSON.stringify(msg)).join("\n");
			await writeFile(join(sessionDir, `${sessionId}.jsonl`), content);
		};

		// Setup: Create test directory
		before(async () => {
			await mkdir(sessionDir, { recursive: true });
		});

		// Cleanup after all tests
		after(async () => {
			await rm(testDir, { recursive: true, force: true });
		});

		it("detects error with isApiErrorMessage flag and returns user-friendly text", async () => {
			const sessionId = "test-api-error";
			await writeTestSession(sessionId, [
				{
					type: "user",
					message: { role: "user", content: "test" },
				},
				{
					type: "assistant",
					error: "authentication_failed",
					isApiErrorMessage: true,
					message: {
						content: [
							{
								type: "text",
								text: "Invalid API key · Fix external API key",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "Invalid API key · Fix external API key");
		});

		it("detects error field without isApiErrorMessage and returns content text", async () => {
			const sessionId = "test-error-field";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					error: "some_error_code",
					message: {
						content: [
							{
								type: "text",
								text: "Something went wrong with your request",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "Something went wrong with your request");
		});

		it("detects error patterns in text content", async () => {
			const sessionId = "test-error-pattern";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Error: Connection timeout occurred",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "Error: Connection timeout occurred");
		});

		it("detects 'invalid api key' pattern (case insensitive)", async () => {
			const sessionId = "test-invalid-key";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Invalid API Key provided",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "Invalid API Key provided");
		});

		it("detects 'failed:' pattern", async () => {
			const sessionId = "test-failed";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Operation failed: Unable to process request",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "Operation failed: Unable to process request");
		});

		it("returns null when no error is present", async () => {
			const sessionId = "test-no-error";
			await writeTestSession(sessionId, [
				{
					type: "user",
					message: { role: "user", content: "hello" },
				},
				{
					type: "assistant",
					message: {
						content: [
							{
								type: "text",
								text: "Hello! How can I help you?",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, null);
		});

		it("returns null when session file does not exist", async () => {
			const error = await getLastMessageError("non-existent-session", testCwd);
			assert.strictEqual(error, null);
		});

		it("returns null when session file is empty", async () => {
			const sessionId = "test-empty";
			await writeFile(join(sessionDir, `${sessionId}.jsonl`), "");

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, null);
		});

		it("handles multiple content blocks and returns first text block", async () => {
			const sessionId = "test-multiple-blocks";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					error: "test_error",
					isApiErrorMessage: true,
					message: {
						content: [
							{
								type: "text",
								text: "First error message",
							},
							{
								type: "text",
								text: "Second message",
							},
						],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "First error message");
		});

		it("falls back to error code if no content text available", async () => {
			const sessionId = "test-no-content";
			await writeTestSession(sessionId, [
				{
					type: "assistant",
					error: "error_code_123",
					isApiErrorMessage: true,
					message: {
						content: [],
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, "error_code_123");
		});

		it("ignores non-assistant messages", async () => {
			const sessionId = "test-user-message";
			await writeTestSession(sessionId, [
				{
					type: "user",
					error: "some_error",
					message: {
						role: "user",
						content: "Error: this is user content",
					},
				},
			]);

			const error = await getLastMessageError(sessionId, testCwd);
			assert.strictEqual(error, null);
		});
	});

	// Note: Integration tests for discoverSessions, loadSessionMessages, etc.
	// should be written as separate integration tests that use actual test
	// session files, rather than complex mocking of fs/promises.
	// See test/integration/ for these tests.
});
