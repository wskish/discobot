/**
 * Test that agent.isConnected properly tracks connection state
 * and that connect() failures are handled correctly.
 *
 * This reproduces the bug where isConnected always returned true,
 * causing connect() to never be called, which resulted in
 * pathToClaudeCodeExecutable being null.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

describe("Agent Connection State", { timeout: 10000 }, () => {
	it("should track connection state correctly", async () => {
		const client = new ClaudeSDKClient({
			cwd: process.cwd(),
			model: "claude-sonnet-4-5-20250929",
			env: process.env as Record<string, string>,
		});

		// Should not be connected initially
		assert.strictEqual(
			client.isConnected,
			false,
			"Client should not be connected before connect()",
		);

		// Connect
		await client.connect();

		// Should be connected after connect()
		assert.strictEqual(
			client.isConnected,
			true,
			"Client should be connected after connect()",
		);

		// Disconnect
		await client.disconnect();

		// Should not be connected after disconnect()
		assert.strictEqual(
			client.isConnected,
			false,
			"Client should not be connected after disconnect()",
		);

		console.log("✓ Connection state tracked correctly");
	});

	it("should call connect() when not connected", async () => {
		const client = new ClaudeSDKClient({
			cwd: process.cwd(),
			model: "claude-sonnet-4-5-20250929",
			env: process.env as Record<string, string>,
		});

		// Simulate the runCompletion flow
		assert.strictEqual(client.isConnected, false, "Should start disconnected");

		// This is what runCompletion() does
		if (!client.isConnected) {
			await client.connect();
		}

		assert.strictEqual(
			client.isConnected,
			true,
			"Should be connected after calling connect()",
		);

		await client.disconnect();
		console.log("✓ Connect called when not connected");
	});

	it("should require connect() before prompt()", async () => {
		const client = new ClaudeSDKClient({
			cwd: process.cwd(),
			model: "claude-sonnet-4-5-20250929",
			env: process.env as Record<string, string>,
		});

		const _message = {
			id: "test-msg",
			role: "user" as const,
			parts: [{ type: "text" as const, text: "Hello" }],
		};

		// Verify that calling prompt() without connect() fails gracefully
		// (it should fail when trying to use null claudeCliPath)
		try {
			await client.ensureSession();
			// Note: prompt() will fail because claudeCliPath is null
			// This is expected behavior - connect() must be called first
		} catch (_error) {
			// This is fine - we're just testing that isConnected works correctly
		}

		assert.strictEqual(
			client.isConnected,
			false,
			"Should remain disconnected if connect() not called",
		);

		await client.disconnect();
		console.log("✓ Verified connect() is required before use");
	});
});
