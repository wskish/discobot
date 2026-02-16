/**
 * Claude CLI session persistence utilities.
 *
 * Claude CLI stores sessions in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * This module provides utilities to discover and load sessions from that directory.
 *
 * The JSONL format stores SDK message types (SDKAssistantMessage, SDKUserMessage)
 * which contain BetaMessage/MessageParam for their content.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	BetaContentBlock,
	BetaTextBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { DynamicToolUIPart, UIMessage } from "ai";

// ============================================================================
// Types
// ============================================================================

export interface ClaudeSessionInfo {
	sessionId: string;
	filePath: string;
	cwd: string;
	lastModified: Date;
	messageCount: number;
}

export interface SessionData {
	sessionId: string;
	messages: UIMessage[];
	metadata: {
		cwd: string;
		gitBranch?: string;
		version?: string;
		messageCount: number;
		recordCount: number;
		lastModified: Date;
	};
}

/**
 * JSONL records can be any SDKMessage type.
 * We extract metadata from system messages and convert user/assistant messages.
 */
type JSONLRecord = SDKMessage & {
	// Additional fields that may appear in JSONL but aren't in SDK types
	gitBranch?: string;
	version?: string;
};

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Encode a file path for use in Claude's directory structure.
 * Claude uses a simple encoding where / becomes -
 */
function encodePathForClaude(path: string): string {
	return path.replace(/\//g, "-");
}

/**
 * Get the Claude projects directory path
 */
function getClaudeProjectsDir(): string {
	return join(homedir(), ".claude", "projects");
}

/**
 * Get the directory where sessions for a specific cwd are stored
 */
export function getSessionDirectoryForCwd(cwd: string): string {
	const encoded = encodePathForClaude(cwd);
	return join(getClaudeProjectsDir(), encoded);
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * Discover all available sessions for a given working directory
 */
export async function discoverSessions(
	cwd: string,
): Promise<ClaudeSessionInfo[]> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const sessions: ClaudeSessionInfo[] = [];

	try {
		// Check if directory exists
		try {
			await stat(sessionDir);
		} catch {
			return sessions;
		}

		const entries = await readdir(sessionDir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				const filePath = join(sessionDir, entry.name);
				const sessionId = entry.name.replace(/\.jsonl$/, "");

				try {
					const stats = await stat(filePath);
					const content = await readFile(filePath, "utf-8");
					const lines = content.trim().split("\n");

					sessions.push({
						sessionId,
						filePath,
						cwd,
						lastModified: stats.mtime,
						messageCount: lines.length,
					});
				} catch (error) {
					console.warn(`Failed to read session file ${filePath}:`, error);
				}
			}
		}
	} catch (error) {
		console.warn(`Failed to read session directory ${sessionDir}:`, error);
	}

	// Sort by last modified (most recent first)
	sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

	return sessions;
}

// ============================================================================
// Session Loading
// ============================================================================

/**
 * Load messages from a Claude SDK session file.
 * Tool results are merged into their corresponding dynamic-tool parts.
 *
 * Note: Claude Code writes partial/incremental updates to JSONL files. Multiple
 * records can have the same message.id but different uuid. We merge these records
 * by message.id to reconstruct complete messages.
 */
export async function loadSessionMessages(
	sessionId: string,
	cwd: string,
): Promise<UIMessage[]> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const filePath = join(sessionDir, `${sessionId}.jsonl`);

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n");

		// Parse all records
		const records: JSONLRecord[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as JSONLRecord);
			} catch (error) {
				console.warn(`Failed to parse JSONL line:`, error);
			}
		}

		// Build messages by merging consecutive assistant messages into one.
		// In an agentic loop, multiple API calls produce multiple assistant messages,
		// but they should be rendered as ONE assistant response with multiple steps.
		//
		// Pattern: user (prompt) → [assistant → user (tool_result)]* → assistant (final)
		// All assistants in that sequence merge into one UIMessage.

		const messages: UIMessage[] = [];
		// Map toolCallId → dynamic-tool part for merging tool results
		const toolParts = new Map<string, DynamicToolUIPart>();
		// Accumulate assistant records for the current turn
		let currentAssistantRecords: SDKAssistantMessage[] = [];
		let currentAssistantMessageId: string | null = null;

		for (const record of records) {
			if (record.type === "assistant") {
				// Accumulate assistant records
				// Use the first assistant message's ID for the merged message
				if (currentAssistantMessageId === null) {
					currentAssistantMessageId = record.message.id;
				}
				currentAssistantRecords.push(record);
			} else if (record.type === "user" && record.uuid) {
				// Check if this user message has actual content (not just tool_results)
				const hasTextContent = userMessageHasTextContent(record);

				if (hasTextContent) {
					// This is a real user message (new prompt)
					// First, finalize any pending assistant turn
					if (currentAssistantRecords.length > 0 && currentAssistantMessageId) {
						const uiMessage = mergeAssistantRecordsIntoOne(
							currentAssistantRecords,
							currentAssistantMessageId,
							toolParts,
						);
						if (uiMessage) {
							messages.push(uiMessage);
						}
						currentAssistantRecords = [];
						currentAssistantMessageId = null;
					}

					// Add the user message
					const uiMessage = userRecordToUIMessage(record, toolParts);
					if (uiMessage) {
						messages.push(uiMessage);
					}
				} else {
					// This is a tool_result-only user message
					// First, ensure tool parts from accumulated records are registered
					if (currentAssistantRecords.length > 0 && currentAssistantMessageId) {
						registerToolPartsFromRecords(
							currentAssistantRecords,
							currentAssistantMessageId,
							toolParts,
						);
					}
					// Now merge tool results into the registered tool parts
					mergeToolResultsFromUserMessage(record, toolParts);
				}
			}
		}

		// Finalize any remaining assistant turn
		if (currentAssistantRecords.length > 0 && currentAssistantMessageId) {
			const uiMessage = mergeAssistantRecordsIntoOne(
				currentAssistantRecords,
				currentAssistantMessageId,
				toolParts,
			);
			if (uiMessage) {
				messages.push(uiMessage);
			}
		}

		return messages;
	} catch (error) {
		console.warn(`Failed to load session ${sessionId}:`, error);
		return [];
	}
}

/**
 * Register tool_use blocks from accumulated assistant records into the toolParts map.
 * This must be called BEFORE merging tool results so the parts exist to merge into.
 */
function registerToolPartsFromRecords(
	records: SDKAssistantMessage[],
	_messageId: string,
	toolParts: Map<string, DynamicToolUIPart>,
): void {
	for (const record of records) {
		const content = record.message.content;
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (block.type === "tool_use" && !toolParts.has(block.id)) {
				// Create and register the tool part
				const part: DynamicToolUIPart = {
					type: "dynamic-tool",
					toolCallId: block.id,
					toolName: block.name,
					state: "input-available",
					input: block.input,
				};
				toolParts.set(block.id, part);
			}
		}
	}
}

/**
 * Check if a user message has actual text content (not just tool_results).
 */
function userMessageHasTextContent(record: SDKUserMessage): boolean {
	const content = record.message.content;
	if (typeof content === "string") {
		return content.trim().length > 0;
	}
	if (Array.isArray(content)) {
		return content.some(
			(block) => block.type === "text" && block.text.trim().length > 0,
		);
	}
	return false;
}

/**
 * Merge tool results from a user message into the tool parts map.
 */
function mergeToolResultsFromUserMessage(
	record: SDKUserMessage,
	toolParts: Map<string, DynamicToolUIPart>,
): void {
	const content = record.message.content;
	if (!Array.isArray(content)) return;

	for (const block of content) {
		if (block.type === "tool_result") {
			const toolPart = toolParts.get(block.tool_use_id);
			if (toolPart) {
				if (block.is_error) {
					toolPart.state = "output-error";
					toolPart.errorText = String(block.content ?? "Tool call failed");
				} else {
					toolPart.state = "output-available";
					toolPart.output = block.content;
				}
			}
		}
	}
}

/**
 * Merge multiple assistant records from an agentic loop into a single UIMessage.
 * This combines all API calls in a turn into one response with multiple parts.
 * Inserts `step-start` parts at boundaries between API calls (steps).
 */
function mergeAssistantRecordsIntoOne(
	records: SDKAssistantMessage[],
	messageId: string,
	toolParts: Map<string, DynamicToolUIPart>,
): UIMessage | null {
	if (records.length === 0) return null;

	const parts: UIMessage["parts"] = [];

	// Collect all content blocks from all records
	// Use a set to track which block IDs we've seen (for tool_use deduplication)
	const seenToolIds = new Set<string>();

	for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
		const record = records[recordIndex];

		// Insert step-start part at the beginning of each step after the first
		// This marks step boundaries so the UI can render them consistently
		// whether content is streamed or loaded from disk
		if (recordIndex > 0) {
			parts.push({ type: "step-start" } as UIMessage["parts"][number]);
		}

		const content = record.message.content;
		for (let index = 0; index < content.length; index++) {
			const block = content[index];

			// For tool_use blocks, use already-registered part (with tool results merged)
			if (block.type === "tool_use") {
				if (seenToolIds.has(block.id)) continue;
				seenToolIds.add(block.id);

				// Use existing part from toolParts map (has tool results already merged)
				// or create a new one if not registered yet
				const existingPart = toolParts.get(block.id);
				if (existingPart) {
					parts.push(existingPart as UIMessage["parts"][number]);
				} else {
					const part = contentBlockToPart(block, messageId, index);
					if (part) {
						parts.push(part);
						if (part.type === "dynamic-tool") {
							toolParts.set(part.toolCallId, part as DynamicToolUIPart);
						}
					}
				}
				continue;
			}

			const part = contentBlockToPart(block, messageId, index);
			if (part) {
				parts.push(part);
			}
		}
	}

	if (parts.length === 0) return null;

	return {
		id: messageId,
		role: "assistant",
		parts,
	};
}

/**
 * Convert an SDKUserMessage to UIMessage.
 * Tool results are merged into their corresponding dynamic-tool parts (not added as new parts).
 * Returns null if the message only contained tool_results (which have been merged).
 */
function userRecordToUIMessage(
	record: SDKUserMessage,
	toolParts: Map<string, DynamicToolUIPart>,
): UIMessage | null {
	const parts: UIMessage["parts"] = [];
	const messageContent = record.message.content;

	// User message content can be string or array
	if (typeof messageContent === "string") {
		parts.push({ type: "text", text: messageContent });
	} else if (Array.isArray(messageContent)) {
		for (const block of messageContent) {
			// User messages can have text blocks or tool_result blocks
			if (block.type === "text") {
				parts.push({ type: "text", text: block.text });
			} else if (block.type === "tool_result") {
				// Merge tool result into existing dynamic-tool part
				const toolPart = toolParts.get(block.tool_use_id);
				if (toolPart) {
					// Update the existing dynamic-tool with output
					if (block.is_error) {
						toolPart.state = "output-error";
						toolPart.errorText = String(block.content ?? "Tool call failed");
					} else {
						toolPart.state = "output-available";
						toolPart.output = block.content;
					}
				}
				// Don't add tool_result as a separate part - it's been merged
			}
		}
	}

	// Return null if message only contained tool_results (no remaining parts)
	if (parts.length === 0) return null;

	return {
		id: record.uuid ?? `user-${Date.now()}`,
		role: "user",
		parts,
	};
}

/**
 * Convert a BetaContentBlock to a UIMessage part.
 */
function contentBlockToPart(
	block: BetaContentBlock,
	_uuid: string,
	_index: number,
): UIMessage["parts"][number] | null {
	switch (block.type) {
		case "text": {
			return {
				type: "text",
				text: block.text,
			};
		}

		case "thinking": {
			return {
				type: "reasoning",
				text: block.thinking,
			};
		}

		case "tool_use": {
			return {
				type: "dynamic-tool",
				toolCallId: block.id,
				toolName: block.name,
				state: "input-available",
				input: block.input,
			} as UIMessage["parts"][number];
		}

		default:
			// Many other BetaContentBlock types exist (server tools, MCP, etc.)
			// that we don't need to convert to UI parts
			return null;
	}
}

// ============================================================================
// Full Session Data Loading
// ============================================================================

/**
 * Load full session data including metadata.
 */
export async function loadFullSessionData(
	sessionId: string,
	cwd: string,
): Promise<SessionData | null> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const filePath = join(sessionDir, `${sessionId}.jsonl`);

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n");
		const stats = await stat(filePath);

		// Extract metadata from records
		let gitBranch: string | undefined;
		let version: string | undefined;

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as JSONLRecord;
				if (!gitBranch && record.gitBranch) {
					gitBranch = record.gitBranch;
				}
				if (!version && record.version) {
					version = record.version;
				}
				// Break early once we have both
				if (gitBranch && version) break;
			} catch {
				// Skip invalid lines
			}
		}

		// Load messages using the standard function
		const messages = await loadSessionMessages(sessionId, cwd);

		return {
			sessionId,
			messages,
			metadata: {
				cwd,
				gitBranch,
				version,
				messageCount: messages.length,
				recordCount: lines.length,
				lastModified: stats.mtime,
			},
		};
	} catch (error) {
		console.warn(`Failed to load full session data:`, error);
		return null;
	}
}

/**
 * Get session metadata without loading all messages
 */
export async function getSessionMetadata(
	sessionId: string,
	cwd: string,
): Promise<ClaudeSessionInfo | null> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const filePath = join(sessionDir, `${sessionId}.jsonl`);

	try {
		const stats = await stat(filePath);
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n");

		return {
			sessionId,
			filePath,
			cwd,
			lastModified: stats.mtime,
			messageCount: lines.length,
		};
	} catch {
		return null;
	}
}

/**
 * Check if the last message in a session file contains an error.
 * Returns the error message if found, or null if no error.
 *
 * This is used to detect when the Claude process crashed and wrote
 * an error to the messages file instead of throwing an exception.
 */
export async function getLastMessageError(
	sessionId: string,
	cwd: string,
): Promise<string | null> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const filePath = join(sessionDir, `${sessionId}.jsonl`);

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n");

		if (lines.length === 0) {
			return null;
		}

		// Get the last line
		const lastLine = lines[lines.length - 1];
		if (!lastLine.trim()) {
			return null;
		}

		// Parse the last message
		const lastMessage = JSON.parse(lastLine) as SDKMessage;

		// Check for error fields at the top level
		const msgWithError = lastMessage as unknown as {
			error?: string;
			errorMessage?: string;
			isApiErrorMessage?: boolean;
			message?: {
				error?: string;
				content?: unknown;
			};
		};

		// If this is an API error message, prefer the user-friendly text from content
		// Only process errors for assistant messages (SDK writes errors as assistant messages)
		if (
			(msgWithError.error || msgWithError.isApiErrorMessage) &&
			lastMessage.type === "assistant"
		) {
			// First try to get user-friendly error text from content
			const msg = lastMessage as SDKAssistantMessage;
			if (msg.message?.content && Array.isArray(msg.message.content)) {
				for (const block of msg.message.content) {
					if (block.type === "text") {
						const text = (block as BetaTextBlock).text;
						// Return the user-friendly error text
						return text;
					}
				}
			}

			// Fall back to error code if no content text found
			if (msgWithError.error) {
				return msgWithError.error;
			}
		}

		// Check if the assistant message contains error text in content
		// (for cases where error field is not set but content indicates error)
		if (lastMessage.type === "assistant") {
			const msg = lastMessage as SDKAssistantMessage;
			if (msg.message?.content && Array.isArray(msg.message.content)) {
				for (const block of msg.message.content) {
					if (block.type === "text") {
						const text = (block as BetaTextBlock).text;
						// Look for error patterns in the text
						const lowerText = text.toLowerCase();
						if (
							lowerText.includes("error:") ||
							lowerText.includes("exception:") ||
							lowerText.includes("failed:") ||
							lowerText.includes("crash") ||
							lowerText.includes("invalid api key")
						) {
							return text;
						}
					}
				}
			}
		}

		// Check other error fields (only for assistant messages)
		if (lastMessage.type === "assistant") {
			if (msgWithError.errorMessage) {
				return msgWithError.errorMessage;
			}
			if (msgWithError.message?.error) {
				return msgWithError.message.error;
			}
		}

		return null;
	} catch (error) {
		console.warn(`Failed to read last message from ${filePath}:`, error);
		return null;
	}
}
