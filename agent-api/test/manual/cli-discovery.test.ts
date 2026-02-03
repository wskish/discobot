/**
 * Test Claude CLI discovery from PATH
 * Usage: tsx scripts/test-cli-discovery.ts
 */

import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

console.log("Testing Claude CLI discovery...\n");

const client = new ClaudeSDKClient({
	cwd: process.cwd(),
	model: "claude-sonnet-4-5-20250929",
	env: process.env as Record<string, string>,
});

try {
	console.log("Calling connect() to discover Claude CLI path...");
	await client.connect();
	console.log("✓ Successfully found Claude CLI");

	// Check the private claudeCliPath field (for testing purposes)
	const cliPath = (client as any).claudeCliPath;
	console.log(`✓ Path: ${cliPath}`);

	await client.disconnect();
	console.log("\n✓ Test completed successfully");
} catch (error) {
	console.error("\n❌ Error:", error);
	process.exit(1);
}
