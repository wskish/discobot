import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { clearCompletionEvents, finishCompletion } from "../store/session.js";
import { createApp } from "./app.js";

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

describe("Git user configuration via headers", () => {
	const testDir = join(tmpdir(), `agent-api-git-config-test-${Date.now()}`);
	let app: ReturnType<typeof createApp>["app"];
	let originalHome: string | undefined;
	let originalGitConfigGlobal: string | undefined;
	let originalGitConfigNosystem: string | undefined;

	before(async () => {
		// Save original environment
		originalHome = process.env.HOME;
		originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
		originalGitConfigNosystem = process.env.GIT_CONFIG_NOSYSTEM;

		// Create isolated test directory for git config
		await mkdir(testDir, { recursive: true });

		// Redirect git global config to test directory.
		// GIT_CONFIG_GLOBAL is the authoritative override — even if HOME gets
		// restored before a background `git config --global` finishes, git will
		// still write to this file instead of ~/.gitconfig.
		process.env.HOME = testDir;
		process.env.XDG_CONFIG_HOME = testDir;
		process.env.GIT_CONFIG_GLOBAL = join(testDir, ".gitconfig");
		process.env.GIT_CONFIG_NOSYSTEM = "1";

		// Initialize a git repo in test directory for the agent
		await git(testDir, "init");
		await git(testDir, "config", "user.email", "initial@example.com");
		await git(testDir, "config", "user.name", "Initial User");
		await writeFile(join(testDir, "README.md"), "# Test\n");
		await git(testDir, "add", "README.md");
		await git(testDir, "commit", "-m", "Initial commit");

		// Create app with test directory as workspace
		const result = createApp({
			agentCwd: testDir,
			enableLogging: false,
		});
		app = result.app;

		// Ensure clean state
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		// Restore original environment
		if (originalHome !== undefined) {
			process.env.HOME = originalHome;
		} else {
			delete process.env.HOME;
		}
		if (originalGitConfigGlobal !== undefined) {
			process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
		} else {
			delete process.env.GIT_CONFIG_GLOBAL;
		}
		if (originalGitConfigNosystem !== undefined) {
			process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNosystem;
		} else {
			delete process.env.GIT_CONFIG_NOSYSTEM;
		}
		delete process.env.XDG_CONFIG_HOME;

		await finishCompletion();
		clearCompletionEvents();
		await rm(testDir, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	});

	it("passes git user headers to completion", async () => {
		// This test verifies that the headers are accepted and the request starts
		// The actual git config setting happens in the background completion

		const res = await app.request("/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Discobot-Git-User-Name": "Test Header User",
				"X-Discobot-Git-User-Email": "header@example.com",
			},
			body: JSON.stringify({
				messages: [
					{
						id: "msg-git-config-test",
						role: "user",
						parts: [{ type: "text", text: "Hello" }],
					},
				],
			}),
		});

		// Should start successfully (202) since no completion is running
		assert.equal(res.status, 202);

		const body = await res.json();
		assert.equal(body.status, "started");
		assert.ok(body.completionId, "Should have completionId");

		// Clean up
		await finishCompletion();
	});

	it("accepts requests without git user headers", async () => {
		// Verify that git headers are optional
		const res = await app.request("/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: [
					{
						id: "msg-no-git-headers",
						role: "user",
						parts: [{ type: "text", text: "Hello" }],
					},
				],
			}),
		});

		// Should start successfully even without git headers
		assert.equal(res.status, 202);

		await finishCompletion();
	});

	it("accepts request with only git user name header", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Discobot-Git-User-Name": "Name Only User",
			},
			body: JSON.stringify({
				messages: [
					{
						id: "msg-name-only",
						role: "user",
						parts: [{ type: "text", text: "Hello" }],
					},
				],
			}),
		});

		assert.equal(res.status, 202);
		await finishCompletion();
	});

	it("accepts request with only git user email header", async () => {
		const res = await app.request("/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Discobot-Git-User-Email": "email@only.com",
			},
			body: JSON.stringify({
				messages: [
					{
						id: "msg-email-only",
						role: "user",
						parts: [{ type: "text", text: "Hello" }],
					},
				],
			}),
		});

		assert.equal(res.status, 202);
		await finishCompletion();
	});
});
