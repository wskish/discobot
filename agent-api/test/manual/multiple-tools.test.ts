/**
 * Test multiple tool types to verify generic tool output capture
 * Usage: ANTHROPIC_API_KEY=xxx tsx scripts/test-multiple-tools.ts
 */

import type { UIMessage } from "ai";
import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
	console.error("❌ ANTHROPIC_API_KEY environment variable is required");
	process.exit(1);
}

console.log("✓ Testing multiple tool types\n");

const client = new ClaudeSDKClient({
	cwd: process.cwd(),
	model: "claude-sonnet-4-5-20250929",
	env: process.env as Record<string, string>,
});

interface ToolExecution {
	toolName: string;
	input: any;
	output: any;
}

const toolExecutions: ToolExecution[] = [];

const testCases = [
	{
		name: "Bash Tool",
		prompt: "Run 'echo hello world' using bash. Just run it, no explanation.",
	},
	{
		name: "Read Tool",
		prompt: "Read the package.json file. Just read it, no explanation.",
	},
	// {
	// 	name: "Write Tool",
	// 	prompt: "Write 'test content' to /tmp/sdk-test.txt. Just do it, no explanation.",
	// },
];

try {
	await client.connect();

	for (const testCase of testCases) {
		console.log(`\n${"=".repeat(60)}`);
		console.log(`Testing: ${testCase.name}`);
		console.log("=".repeat(60));

		const sessionId = `test-${testCase.name.toLowerCase().replace(/\s+/g, "-")}`;
		await client.ensureSession(sessionId);

		// Set callback to capture tool executions
		client.setUpdateCallback((chunk) => {
			if (chunk.type === "tool-input-available") {
				const toolChunk = chunk as any;
				console.log(`\n[INPUT] Tool: ${toolChunk.toolName}`);
				console.log(`  Input: ${JSON.stringify(toolChunk.input, null, 2)}`);
			}

			if (chunk.type === "tool-output-available") {
				const toolChunk = chunk as any;
				console.log(`\n[OUTPUT] Call ID: ${toolChunk.toolCallId}`);
				const output = toolChunk.output;

				console.log(`  Output type: ${typeof output}`);
				console.log(`  Is array: ${Array.isArray(output)}`);
				console.log(
					`  Is object: ${typeof output === "object" && output !== null}`,
				);

				if (typeof output === "object" && output !== null) {
					console.log(`  Keys: ${Object.keys(output).join(", ")}`);
					console.log(
						`  Structure: ${JSON.stringify(output, null, 2).substring(0, 400)}...`,
					);
				} else {
					console.log(`  Value: ${output}`);
				}

				// Record for comparison
				const inputChunk = (client.getSession(sessionId)?.getMessages() || [])
					.find((m) => m.role === "assistant")
					?.parts.find((p) => p.type === "dynamic-tool") as any;

				if (inputChunk) {
					toolExecutions.push({
						toolName: inputChunk.toolName,
						input: inputChunk.input,
						output: output,
					});
				}
			}
		}, sessionId);

		const userMessage: UIMessage = {
			id: `msg-${sessionId}`,
			role: "user",
			parts: [
				{
					type: "text",
					text: testCase.prompt,
				},
			],
		};

		await client.prompt(userMessage, sessionId);
		console.log(`\n✓ ${testCase.name} completed`);
	}

	await client.disconnect();

	console.log(`\n${"=".repeat(60)}`);
	console.log("SUMMARY: Tool Output Structures");
	console.log("=".repeat(60));

	for (const exec of toolExecutions) {
		console.log(`\n${exec.toolName}:`);
		console.log(`  Input type: ${typeof exec.input}`);
		console.log(`  Output type: ${typeof exec.output}`);

		if (typeof exec.output === "object" && exec.output !== null) {
			console.log(`  Output keys: ${Object.keys(exec.output).join(", ")}`);

			// Check for common patterns
			if ("stdout" in exec.output && "stderr" in exec.output) {
				console.log(`  Pattern: Bash-style (stdout/stderr)`);
			} else if ("content" in exec.output) {
				console.log(`  Pattern: Content-based`);
			} else if (Array.isArray(exec.output)) {
				console.log(`  Pattern: Array of items`);
			}
		}
	}

	console.log(`\n✓ All tool types tested successfully`);
	console.log(
		`\nConclusion: ${toolExecutions.length > 0 ? "Tool outputs are generic objects/structures" : "No tools executed"}`,
	);
} catch (error) {
	console.error("\n❌ Error:", error);
	process.exit(1);
}
