import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { ClaudeSDKClient } from "../../src/claude-sdk/client.js";

// Tool part type for testing (subset of DynamicToolUIPart)
interface ToolPart {
	type: string;
	toolName?: string;
	toolCallId?: string;
	state?: string;
	input?: unknown;
	output?: unknown;
}

const TIMEOUT_MS = 120000; // 2 minutes
const TEST_CWD = process.cwd();

if (!process.env.ANTHROPIC_API_KEY) {
	console.log("⚠️  Skipping Tool Execution tests: ANTHROPIC_API_KEY not set");
}

// We'll check for Claude CLI during test setup (client.connect() will throw if not found)
const shouldSkip = !process.env.ANTHROPIC_API_KEY;

describe("Tool Execution Integration", { skip: shouldSkip }, () => {
	let client: ClaudeSDKClient;

	before(async () => {
		client = new ClaudeSDKClient({
			cwd: TEST_CWD,
			model: "claude-sonnet-4-5-20250929",
			env: process.env as Record<string, string>,
		});
		await client.connect();
	});

	after(async () => {
		if (client) {
			await client.disconnect();
		}
	});

	describe("Bash Tool Execution", () => {
		it(
			"should execute bash tool with full lifecycle: input → execution → output",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-bash-tool";
				const allChunks: UIMessageChunk[] = [];
				const toolChunks: UIMessageChunk[] = [];

				await client.ensureSession(sessionId);

				const userMessage: UIMessage = {
					id: "msg-bash-test",
					role: "user",
					parts: [
						{
							type: "text",
							text: "List the files in the current directory using ls. Just run the command, don't explain.",
						},
					],
				};

				// Iterate over the async generator to capture all chunks
				for await (const chunk of client.prompt(userMessage, sessionId)) {
					allChunks.push(chunk as UIMessageChunk);
					if (
						chunk.type === "tool-input-start" ||
						chunk.type === "tool-input-delta" ||
						chunk.type === "tool-input-available" ||
						chunk.type === "tool-output-available" ||
						chunk.type === "tool-output-error"
					) {
						toolChunks.push(chunk as UIMessageChunk);
					}
				}

				console.log(
					`\nReceived ${allChunks.length} total chunks, ${toolChunks.length} tool-related chunks`,
				);

				// Verify we got tool chunks
				assert.ok(
					toolChunks.length > 0,
					`Should have tool chunks, got ${toolChunks.length}`,
				);

				// Find tool-input-start chunk
				const inputStartChunk = toolChunks.find(
					(c) => c.type === "tool-input-start",
				);
				assert.ok(inputStartChunk, "Should have tool-input-start chunk");
				console.log("✓ Found tool-input-start chunk:", inputStartChunk);

				// Find tool-input-available chunk
				const inputAvailableChunk = toolChunks.find(
					(c) => c.type === "tool-input-available",
				);
				assert.ok(
					inputAvailableChunk,
					"Should have tool-input-available chunk",
				);
				console.log(
					"✓ Found tool-input-available chunk:",
					JSON.stringify(inputAvailableChunk, null, 2),
				);

				// Verify tool name and input
				if (inputAvailableChunk.type === "tool-input-available") {
					assert.ok(
						inputAvailableChunk.toolName,
						"Tool name should be present",
					);
					console.log(`✓ Tool name: ${inputAvailableChunk.toolName}`);

					assert.ok(inputAvailableChunk.input, "Tool input should be present");
					console.log(
						`✓ Tool input: ${JSON.stringify(inputAvailableChunk.input, null, 2)}`,
					);

					// For Bash tool, should have 'command' property
					if (inputAvailableChunk.toolName === "Bash") {
						const input = inputAvailableChunk.input as {
							command?: string;
						};
						assert.ok(input.command, "Bash tool should have command property");
						assert.ok(
							input.command.includes("ls"),
							"Command should include 'ls'",
						);
						console.log(`✓ Bash command: ${input.command}`);
					}
				}

				// Find tool-output-available chunk
				const outputAvailableChunk = toolChunks.find(
					(c) => c.type === "tool-output-available",
				);
				assert.ok(
					outputAvailableChunk,
					"Should have tool-output-available chunk",
				);
				console.log(
					"✓ Found tool-output-available chunk:",
					JSON.stringify(outputAvailableChunk, null, 2),
				);

				// Verify tool output
				if (outputAvailableChunk.type === "tool-output-available") {
					assert.ok(
						outputAvailableChunk.output,
						"Tool output should be present",
					);
					console.log(
						`✓ Tool output length: ${JSON.stringify(outputAvailableChunk.output).length} chars`,
					);
				}

				// Check final message structure
				const messages = client.getSession(sessionId)?.getMessages() ?? [];
				const assistantMsg = messages.find((m) => m.role === "assistant");
				assert.ok(assistantMsg, "Should have assistant message");

				console.log(
					`\n✓ Final assistant message has ${assistantMsg.parts.length} parts:`,
				);
				for (const [i, part] of assistantMsg.parts.entries()) {
					console.log(
						`  Part ${i + 1}: type=${part.type}, ${JSON.stringify(part).substring(0, 100)}...`,
					);
				}

				// Find dynamic-tool part
				const toolParts = assistantMsg.parts.filter(
					(p) => p.type === "dynamic-tool",
				);
				assert.ok(
					toolParts.length > 0,
					`Should have at least one dynamic-tool part, got ${toolParts.length}`,
				);
				console.log(`\n✓ Found ${toolParts.length} dynamic-tool part(s)`);

				for (const toolPart of toolParts) {
					const tool = toolPart as ToolPart;
					console.log(`\nTool part details:`);
					console.log(`  toolName: ${tool.toolName}`);
					console.log(`  toolCallId: ${tool.toolCallId}`);
					console.log(`  state: ${tool.state}`);
					console.log(`  input: ${JSON.stringify(tool.input, null, 2)}`);
					console.log(
						`  output: ${JSON.stringify(tool.output || "none").substring(0, 200)}...`,
					);

					assert.ok(tool.toolName, "Tool should have name");
					assert.ok(tool.toolCallId, "Tool should have call ID");
					assert.ok(tool.state, "Tool should have state");
					assert.ok(tool.input, "Tool should have input");

					// State should be output-available after execution
					if (tool.state === "output-available") {
						assert.ok(
							tool.output,
							"Tool with output-available should have output",
						);
						console.log("✓ Tool has output in output-available state");
					} else {
						console.warn(
							`⚠ Tool state is ${tool.state}, expected output-available`,
						);
					}
				}
			},
		);
	});

	describe("Read Tool Execution", () => {
		it(
			"should execute Read tool and capture file contents",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-read-tool";
				const allChunks: UIMessageChunk[] = [];
				const toolChunks: UIMessageChunk[] = [];

				await client.ensureSession(sessionId);

				const userMessage: UIMessage = {
					id: "msg-read-test",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Read the package.json file in the current directory. Just read it, don't explain.",
						},
					],
				};

				// Iterate over the async generator to capture all chunks
				for await (const chunk of client.prompt(userMessage, sessionId)) {
					allChunks.push(chunk as UIMessageChunk);
					if (
						chunk.type === "tool-input-start" ||
						chunk.type === "tool-input-available" ||
						chunk.type === "tool-output-available" ||
						chunk.type === "tool-output-error"
					) {
						toolChunks.push(chunk as UIMessageChunk);
					}
				}

				console.log(
					`\nReceived ${allChunks.length} total chunks, ${toolChunks.length} tool-related chunks`,
				);

				// Find Read tool
				const inputAvailableChunk = toolChunks.find(
					(c) => c.type === "tool-input-available",
				);
				assert.ok(
					inputAvailableChunk,
					"Should have tool-input-available chunk",
				);

				if (inputAvailableChunk.type === "tool-input-available") {
					console.log(`✓ Tool name: ${inputAvailableChunk.toolName}`);
					console.log(
						`✓ Tool input: ${JSON.stringify(inputAvailableChunk.input, null, 2)}`,
					);

					// For Read tool, should have 'file_path' property
					if (inputAvailableChunk.toolName === "Read") {
						const input = inputAvailableChunk.input as {
							file_path?: string;
						};
						assert.ok(
							input.file_path,
							"Read tool should have file_path property",
						);
						assert.ok(
							input.file_path.includes("package.json"),
							"File path should include 'package.json'",
						);
						console.log(`✓ Reading file: ${input.file_path}`);
					}
				}

				// Verify output
				const outputAvailableChunk = toolChunks.find(
					(c) => c.type === "tool-output-available",
				);
				assert.ok(
					outputAvailableChunk,
					"Should have tool-output-available chunk",
				);

				// Check final message has tool part with output
				const messages = client.getSession(sessionId)?.getMessages() ?? [];
				const assistantMsg = messages.find((m) => m.role === "assistant");
				assert.ok(assistantMsg, "Should have assistant message");

				const toolParts = assistantMsg.parts.filter(
					(p) => p.type === "dynamic-tool",
				);
				assert.ok(
					toolParts.length > 0,
					"Should have at least one dynamic-tool part",
				);

				const readToolPart = toolParts.find(
					(p) => (p as ToolPart).toolName === "Read",
				);
				if (readToolPart) {
					const tool = readToolPart as ToolPart;
					console.log(`\n✓ Read tool found in final message:`);
					console.log(`  State: ${tool.state}`);
					console.log(`  Input: ${JSON.stringify(tool.input, null, 2)}`);
					console.log(
						`  Output length: ${tool.output ? JSON.stringify(tool.output).length : 0} chars`,
					);

					if (tool.state === "output-available") {
						assert.ok(tool.output, "Read tool should have output");
						console.log("✓ Read tool has output");
					}
				}
			},
		);
	});

	describe("Tool State Tracking", () => {
		it(
			"should track tool state transitions correctly",
			{ timeout: TIMEOUT_MS },
			async () => {
				const sessionId = "test-tool-states";
				const toolStates: Array<{
					toolCallId: string;
					state: string;
					timestamp: number;
				}> = [];

				await client.ensureSession(sessionId);

				const userMessage: UIMessage = {
					id: "msg-state-test",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Run 'echo hello' using bash. Just run it, no explanation.",
						},
					],
				};

				// Iterate over the async generator to capture tool states
				for await (const chunk of client.prompt(userMessage, sessionId)) {
					if (
						chunk.type === "tool-input-start" ||
						chunk.type === "tool-input-available" ||
						chunk.type === "tool-output-available" ||
						chunk.type === "tool-output-error"
					) {
						const toolChunk = chunk as ToolPart;
						toolStates.push({
							toolCallId: toolChunk.toolCallId || "unknown",
							state: chunk.type,
							timestamp: Date.now(),
						});
					}
				}

				console.log(
					`\n✓ Captured ${toolStates.length} tool state transitions:`,
				);
				for (const state of toolStates) {
					console.log(`  ${state.toolCallId}: ${state.state}`);
				}

				// Verify state transition order
				assert.ok(
					toolStates.length >= 2,
					`Should have at least 2 states (input + output), got ${toolStates.length}`,
				);

				// Group by toolCallId
				const byToolId = new Map<string, string[]>();
				for (const state of toolStates) {
					if (!byToolId.has(state.toolCallId)) {
						byToolId.set(state.toolCallId, []);
					}
					byToolId.get(state.toolCallId)?.push(state.state);
				}

				// Check each tool's state progression
				for (const [toolId, states] of byToolId.entries()) {
					console.log(
						`\n✓ Tool ${toolId} state progression: ${states.join(" → ")}`,
					);

					// Should start with input states
					const firstState = states[0];
					assert.ok(
						firstState === "tool-input-start" ||
							firstState === "tool-input-available",
						`First state should be input-related, got ${firstState}`,
					);

					// Should end with output state
					const lastState = states[states.length - 1];
					assert.ok(
						lastState === "tool-output-available" ||
							lastState === "tool-output-error",
						`Last state should be output-related, got ${lastState}`,
					);

					// If we have both start and available, start should come before available
					const startIndex = states.indexOf("tool-input-start");
					const availableIndex = states.indexOf("tool-input-available");
					if (startIndex !== -1 && availableIndex !== -1) {
						assert.ok(
							startIndex < availableIndex,
							"tool-input-start should come before tool-input-available",
						);
					}
				}
			},
		);
	});
});
