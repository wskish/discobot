import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type { UIMessageChunk } from "ai";
import {
	addCompletionEvent,
	clearCompletionEvents,
	finishCompletion,
	startCompletion,
} from "../store/session.js";
import { createApp } from "./app.js";

describe("GET /chat SSE endpoint", () => {
	let app: ReturnType<typeof createApp>["app"];

	before(async () => {
		const result = createApp({
			agentCwd: process.cwd(),
			enableLogging: false,
		});
		app = result.app;

		// Ensure clean state
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	describe("SSE mode (Accept: text/event-stream)", () => {
		it("returns 204 No Content when no completion is running", async () => {
			// Ensure no completion is running
			await finishCompletion();

			const res = await app.request("/chat", {
				headers: { Accept: "text/event-stream" },
			});

			assert.equal(res.status, 204);
		});

		it("returns SSE stream when completion is running", async () => {
			// Start a completion and add all events before requesting
			startCompletion("sse-test-completion");

			const events: UIMessageChunk[] = [
				{ type: "start", messageId: "msg-sse-test" },
				{ type: "text-start", id: "text-msg-sse-test-1" },
				{
					type: "text-delta",
					id: "text-msg-sse-test-1",
					delta: "Hello World",
				},
				{ type: "text-end", id: "text-msg-sse-test-1" },
				{ type: "finish" },
			];

			for (const event of events) {
				addCompletionEvent(event);
			}

			// Finish the completion before requesting (synchronous test)
			await finishCompletion();

			// Note: Since completion just finished, isCompletionRunning() returns false
			// This means we need to test while completion is still running
			// Re-start for the actual test
			clearCompletionEvents();
			startCompletion("sse-test-completion-2");
			for (const event of events) {
				addCompletionEvent(event);
			}

			// Request SSE stream (completion still running)
			const res = await app.request("/chat", {
				headers: { Accept: "text/event-stream" },
			});

			assert.equal(res.status, 200);
			const contentType = res.headers.get("Content-Type");
			assert.ok(
				contentType?.includes("text/event-stream"),
				`Expected text/event-stream, got ${contentType}`,
			);

			// Now finish so the stream completes
			await finishCompletion();

			// Read the stream
			const body = await res.text();

			// Verify events are present in the stream
			assert.ok(body.includes("data:"), "Should contain SSE data lines");
			assert.ok(body.includes("msg-sse-test"), "Should contain the message ID");
			assert.ok(body.includes("Hello World"), "Should contain the text delta");
			assert.ok(body.includes("[DONE]"), "Should contain [DONE] signal");
		});
	});

	describe("SSE event format", () => {
		it("formats events as JSON in SSE data lines", async () => {
			// Setup: add events before requesting
			clearCompletionEvents();
			startCompletion("format-test");

			const testEvent: UIMessageChunk = {
				type: "text-delta",
				id: "text-format-1",
				delta: "Test content",
			};
			addCompletionEvent({ type: "start", messageId: "msg-format" });
			addCompletionEvent(testEvent);
			addCompletionEvent({ type: "finish" });

			// Request SSE stream
			const res = await app.request("/chat", {
				headers: { Accept: "text/event-stream" },
			});

			// Finish completion so stream ends
			await finishCompletion();

			const body = await res.text();

			// Each event should be on a "data: " line as JSON
			const lines = body.split("\n").filter((line) => line.startsWith("data:"));
			assert.ok(lines.length >= 2, "Should have multiple data lines");

			// Find the text-delta event line
			const deltaLine = lines.find((line) => line.includes("text-delta"));
			assert.ok(deltaLine, "Should have a text-delta line");

			// Parse the JSON from the data line
			const jsonStr = deltaLine.replace("data: ", "").trim();
			const parsed = JSON.parse(jsonStr);
			assert.equal(parsed.type, "text-delta");
			assert.equal(parsed.delta, "Test content");
		});

		it("ends stream with [DONE] signal", async () => {
			clearCompletionEvents();
			startCompletion("done-test");
			addCompletionEvent({ type: "start", messageId: "msg-done" });
			addCompletionEvent({ type: "finish" });

			const res = await app.request("/chat", {
				headers: { Accept: "text/event-stream" },
			});

			await finishCompletion();

			const body = await res.text();
			const lines = body.split("\n");
			const doneLines = lines.filter((line) => line.includes("[DONE]"));
			assert.ok(doneLines.length > 0, "Should have [DONE] line");
		});
	});
});

describe("POST /chat conflict handling", () => {
	let app: ReturnType<typeof createApp>["app"];

	before(async () => {
		const result = createApp({
			agentCwd: process.cwd(),
			enableLogging: false,
		});
		app = result.app;
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	it("returns 409 Conflict when completion is already running", async () => {
		// Start a completion manually to simulate one in progress
		startCompletion("existing-completion");

		try {
			const res = await app.request("/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [
						{
							id: "msg-1",
							role: "user",
							parts: [{ type: "text", text: "Hello" }],
						},
					],
				}),
			});

			assert.equal(res.status, 409);

			const body = await res.json();
			assert.equal(body.error, "completion_in_progress");
			assert.equal(body.completionId, "existing-completion");
		} finally {
			await finishCompletion();
		}
	});

	it("returns 400 for missing messages array", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.error, "messages array required");
	});

	it("returns 400 for messages without user message", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{
						id: "msg-1",
						role: "assistant",
						parts: [{ type: "text", text: "Hi there" }],
					},
				],
			}),
		});

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.error, "No user message found");
	});
});

describe("GET /chat/status", () => {
	let app: ReturnType<typeof createApp>["app"];

	before(async () => {
		const result = createApp({
			agentCwd: process.cwd(),
			enableLogging: false,
		});
		app = result.app;
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	it("returns status when no completion is running", async () => {
		await finishCompletion();

		const res = await app.request("/chat/status");
		assert.equal(res.status, 200);

		const body = await res.json();
		assert.equal(body.isRunning, false);
	});

	it("returns status when completion is running", async () => {
		startCompletion("status-test-completion");

		try {
			const res = await app.request("/chat/status");
			assert.equal(res.status, 200);

			const body = await res.json();
			assert.equal(body.isRunning, true);
			assert.equal(body.completionId, "status-test-completion");
			assert.ok(body.startedAt, "Should have startedAt timestamp");
		} finally {
			await finishCompletion();
		}
	});

	it("returns error after failed completion", async () => {
		startCompletion("failed-completion");
		await finishCompletion("Connection timeout");

		const res = await app.request("/chat/status");
		assert.equal(res.status, 200);

		const body = await res.json();
		assert.equal(body.isRunning, false);
		assert.equal(body.error, "Connection timeout");
		assert.equal(body.completionId, "failed-completion");
	});
});

// ============================================================================
// GET /commits endpoint tests
// ============================================================================

const execAsync = promisify(exec);

/**
 * Helper to run git commands in a directory
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const escapedArgs = args.map((arg) => {
		if (/[\s"'\\]/.test(arg)) {
			return `"${arg.replace(/"/g, '\\"')}"`;
		}
		return arg;
	});
	const { stdout } = await execAsync(`git ${escapedArgs.join(" ")}`, { cwd });
	return stdout.trim();
}

/**
 * Helper to create a git repo with initial commit
 */
async function createGitRepo(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	await git(dir, "init");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test User");
	await writeFile(join(dir, "README.md"), "# Test Repository\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-m", "Initial commit");
	return git(dir, "rev-parse", "HEAD");
}

describe("GET /commits endpoint", () => {
	const testDir = "/tmp/agent-api-commits-integration-test";
	let app: ReturnType<typeof createApp>["app"];
	let initialCommit: string;

	before(async () => {
		// Clean up and create test repo
		await rm(testDir, { recursive: true, force: true });
		initialCommit = await createGitRepo(testDir);

		// Add a commit so we have something to return
		await writeFile(join(testDir, "file.txt"), "content\n");
		await git(testDir, "add", "file.txt");
		await git(testDir, "commit", "-m", "Add file");

		// Create app with test repo as workspace
		const result = createApp({
			agentCwd: testDir,
			enableLogging: false,
		});
		app = result.app;
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("returns 400 when parent query parameter is missing", async () => {
		const res = await app.request("/commits");

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.error, "invalid_parent");
	});

	it("returns 400 for invalid parent commit", async () => {
		const res = await app.request(
			"/commits?parent=0000000000000000000000000000000000000000",
		);

		assert.equal(res.status, 400);
		const body = await res.json();
		assert.equal(body.error, "invalid_parent");
	});

	it("returns 404 when no commits since parent", async () => {
		// Get current HEAD
		const head = await git(testDir, "rev-parse", "HEAD");

		const res = await app.request(`/commits?parent=${head}`);

		assert.equal(res.status, 404);
		const body = await res.json();
		assert.equal(body.error, "no_commits");
	});

	it("returns patches for commits since parent", async () => {
		const res = await app.request(`/commits?parent=${initialCommit}`);

		assert.equal(res.status, 200);
		const body = await res.json();

		assert.equal(body.commitCount, 1);
		assert.ok(body.patches.length > 0, "Should have patches");
		assert.ok(
			body.patches.includes("Add file"),
			"Should include commit message",
		);
		assert.ok(body.patches.includes("file.txt"), "Should include filename");
	});

	it("returns patches for multiple commits", async () => {
		// Add more commits
		await writeFile(join(testDir, "file2.txt"), "content2\n");
		await git(testDir, "add", "file2.txt");
		await git(testDir, "commit", "-m", "Add file2");

		await writeFile(join(testDir, "file3.txt"), "content3\n");
		await git(testDir, "add", "file3.txt");
		await git(testDir, "commit", "-m", "Add file3");

		const res = await app.request(`/commits?parent=${initialCommit}`);

		assert.equal(res.status, 200);
		const body = await res.json();

		assert.equal(body.commitCount, 3);
		assert.ok(body.patches.includes("Add file"));
		assert.ok(body.patches.includes("Add file2"));
		assert.ok(body.patches.includes("Add file3"));
	});
});
