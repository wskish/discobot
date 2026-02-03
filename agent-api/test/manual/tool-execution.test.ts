/**
 * Manual tool execution test - run this to see actual tool behavior
 * Usage: ANTHROPIC_API_KEY=xxx tsx scripts/test-tool-manually.ts
 */

import type { UIMessage } from "ai";
import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
	console.error("❌ ANTHROPIC_API_KEY environment variable is required");
	process.exit(1);
}

console.log("✓ API Key found");
console.log("✓ Starting tool execution test...\n");

const client = new ClaudeSDKClient({
	cwd: process.cwd(),
	model: "claude-sonnet-4-5-20250929",
	env: process.env as Record<string, string>,
});

const sessionId = "manual-test";
let chunkCount = 0;
const toolInputChunks: any[] = [];
const toolOutputChunks: any[] = [];

try {
	console.log("Connecting to Claude SDK...");
	await client.connect();
	console.log("✓ Connected\n");

	await client.ensureSession(sessionId);
	console.log("✓ Session created\n");

	// Set callback AFTER ensuring session exists
	client.setUpdateCallback((chunk) => {
		chunkCount++;

		// Log all chunks with details
		console.log(`\n[CHUNK ${chunkCount}] type: ${chunk.type}`);

		if (chunk.type === "tool-input-start") {
			console.log(`  Tool: ${(chunk as any).toolName}`);
			console.log(`  Call ID: ${(chunk as any).toolCallId}`);
			toolInputChunks.push(chunk);
		}

		if (chunk.type === "tool-input-available") {
			console.log(`  Tool: ${(chunk as any).toolName}`);
			console.log(`  Call ID: ${(chunk as any).toolCallId}`);
			console.log(`  Input: ${JSON.stringify((chunk as any).input, null, 2)}`);
			toolInputChunks.push(chunk);
		}

		if (chunk.type === "tool-output-available") {
			console.log(`  Call ID: ${(chunk as any).toolCallId}`);
			const output = (chunk as any).output;
			console.log(`  Output type: ${typeof output}`);
			console.log(
				`  Output keys: ${output && typeof output === "object" ? Object.keys(output).join(", ") : "N/A"}`,
			);
			console.log(
				`  Output (first 200 chars): ${JSON.stringify(output).substring(0, 200)}...`,
			);
			toolOutputChunks.push(chunk);
		}

		if (chunk.type === "tool-output-error") {
			console.log(`  Call ID: ${(chunk as any).toolCallId}`);
			console.log(`  Error: ${JSON.stringify((chunk as any).output)}`);
			toolOutputChunks.push(chunk);
		}
	}, sessionId);

	// Test with different tool types
	const testPrompts = [
		"List files in the current directory using ls. Just run it, don't explain.",
		// "Read the package.json file. Just read it, don't explain.",
		// "Write 'test' to a file called /tmp/test.txt. Just do it, don't explain.",
	];

	const userMessage: UIMessage = {
		id: "test-msg",
		role: "user",
		parts: [
			{
				type: "text",
				text: testPrompts[0],
			},
		],
	};

	console.log("Sending prompt: 'List files using ls'");
	console.log("=".repeat(60));

	await client.prompt(userMessage, sessionId);

	console.log(`\n${"=".repeat(60)}`);
	console.log("✓ Prompt completed\n");

	// Summary
	console.log("SUMMARY:");
	console.log(`  Total chunks received: ${chunkCount}`);
	console.log(`  Tool input chunks: ${toolInputChunks.length}`);
	console.log(`  Tool output chunks: ${toolOutputChunks.length}`);

	// Check final message
	const messages = client.getSession(sessionId)?.getMessages() ?? [];
	const assistantMsg = messages.find((m) => m.role === "assistant");

	if (assistantMsg) {
		console.log(`\n  Assistant message parts: ${assistantMsg.parts.length}`);
		for (const [i, part] of assistantMsg.parts.entries()) {
			console.log(`    Part ${i + 1}: type=${part.type}`);
			if (part.type === "dynamic-tool") {
				const tool = part as any;
				console.log(`      Tool: ${tool.toolName}`);
				console.log(`      State: ${tool.state}`);
				console.log(`      Input: ${JSON.stringify(tool.input)}`);
				console.log(`      Has output: ${!!tool.output}`);
				if (tool.output) {
					console.log(
						`      Output length: ${JSON.stringify(tool.output).length} chars`,
					);
				}
			}
		}
	}

	await client.disconnect();
	console.log("\n✓ Test completed successfully");
} catch (error) {
	console.error("\n❌ Error:", error);
	process.exit(1);
}
