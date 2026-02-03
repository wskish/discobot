import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";

/**
 * Claude SDK stores sessions in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * This module provides utilities to discover and load sessions from that directory.
 *
 * The JSONL format stores SDK-style messages with enriched metadata. The core message
 * structures match SDKUserMessage and SDKAssistantMessage from the SDK, but include
 * additional fields for session tracking (cwd, gitBranch, version, timestamp, etc.).
 */

export interface ClaudeSessionInfo {
	sessionId: string;
	filePath: string;
	cwd: string;
	lastModified: Date;
	messageCount: number;
}

/**
 * Encode a file path for use in Claude's directory structure.
 * Claude uses a simple encoding where / becomes -
 */
function encodePathForClaude(path: string): string {
	// Remove leading slash and replace remaining slashes with dashes
	return path.replace(/^\//, "").replace(/\//g, "-");
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

/**
 * Discover all available sessions for a given working directory
 */
export async function discoverSessions(
	cwd: string,
): Promise<ClaudeSessionInfo[]> {
	const sessionDir = getSessionDirectoryForCwd(cwd);
	const sessions: ClaudeSessionInfo[] = [];

	try {
		// Check if directory exists first
		try {
			await stat(sessionDir);
		} catch {
			// Directory doesn't exist yet - return empty array
			return sessions;
		}

		const entries = await readdir(sessionDir, { withFileTypes: true });

		for (const entry of entries) {
			// Look for .jsonl files that are not in subdirectories
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
		// Directory doesn't exist or can't be read
		console.warn(`Failed to read session directory ${sessionDir}:`, error);
	}

	// Sort by last modified (most recent first)
	sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

	return sessions;
}

/**
 * JSONL record types - these closely match SDK types with additional metadata
 *
 * The JSONL format stores messages similar to SDKUserMessage/SDKAssistantMessage
 * but with enriched metadata:
 * - cwd, gitBranch, version, timestamp
 * - parentUuid, isSidechain, userType
 * - permissionMode (for user messages)
 * - requestId (for assistant messages)
 *
 * Message content follows Anthropic API format:
 * - User messages: { role: "user", content: string | ContentBlock[] }
 * - Assistant messages: { id, role: "assistant", content: ContentBlock[], ... }
 */
interface BaseJSONLRecord {
	type: string;
	uuid?: string;
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	gitBranch?: string;
	version?: string;
	parentUuid?: string | null;
	isSidechain?: boolean;
	userType?: string;
	slug?: string;
}

/**
 * User message record - similar to SDKUserMessage with metadata
 */
interface UserMessageRecord extends BaseJSONLRecord {
	type: "user";
	message: {
		role: "user";
		content: string | ContentBlock[];
	};
	permissionMode?: string;
}

/**
 * Assistant message record - similar to SDKAssistantMessage with metadata
 */
interface AssistantMessageRecord extends BaseJSONLRecord {
	type: "assistant";
	message: {
		id: string;
		role: "assistant";
		content: ContentBlock[];
		model?: string;
		stop_reason?: string;
		usage?: unknown;
	};
	requestId?: string;
}

/**
 * Generic message record (same as assistant)
 */
interface MessageRecord extends BaseJSONLRecord {
	type: "message";
	message: {
		id: string;
		role: "assistant";
		content: ContentBlock[];
		model?: string;
		stop_reason?: string;
		usage?: unknown;
	};
	requestId?: string;
}

/**
 * Progress tracking record
 */
interface ProgressRecord extends BaseJSONLRecord {
	type: "progress";
	data: {
		type: "hook_progress" | "agent_progress" | "bash_progress" | string;
		hookEvent?: string;
		hookName?: string;
		command?: string;
		[key: string]: unknown;
	};
	toolUseID?: string;
	parentToolUseID?: string;
}

/**
 * Queue operation record (session lifecycle events)
 */
interface QueueOperationRecord {
	type: "queue-operation";
	operation: string; // "dequeue", etc.
	sessionId: string;
	timestamp: string;
}

type ClaudeJSONLRecord =
	| UserMessageRecord
	| AssistantMessageRecord
	| MessageRecord
	| ProgressRecord
	| QueueOperationRecord
	| BaseJSONLRecord;

/**
 * Content block types from Anthropic SDK
 */
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

interface ToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | unknown;
	is_error?: boolean;
}

/**
 * Extended thinking block (when extended thinking is enabled)
 */
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}

/**
 * Load messages from a Claude SDK session file with comprehensive parsing
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
		const messages: UIMessage[] = [];

		// Track tool results to merge them into tool calls
		const toolResults = new Map<string, ToolResultBlock>();

		// First pass: collect tool results
		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const record = JSON.parse(line) as ClaudeJSONLRecord;

				if (
					(record.type === "user" ||
						record.type === "assistant" ||
						record.type === "message") &&
					"message" in record &&
					record.message
				) {
					const content = getMessageContent(record.message);
					for (const block of content) {
						if (block.type === "tool_result") {
							toolResults.set(block.tool_use_id, block);
						}
					}
				}
			} catch (_error) {
				// Skip invalid lines
			}
		}

		// Second pass: build messages
		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const record = JSON.parse(line) as ClaudeJSONLRecord;

				// Process user and assistant messages (only if they have a uuid)
				if (
					(record.type === "user" ||
						record.type === "assistant" ||
						record.type === "message") &&
					"message" in record &&
					record.message &&
					record.uuid
				) {
					const uiMessage = claudeMessageToUIMessage(
						record as (
							| UserMessageRecord
							| AssistantMessageRecord
							| MessageRecord
						) & {
							uuid: string;
						},
						toolResults,
					);
					if (uiMessage) {
						messages.push(uiMessage);
					}
				}
			} catch (error) {
				console.warn(`Failed to parse JSONL line:`, error);
			}
		}

		return messages;
	} catch (error) {
		console.warn(`Failed to load session ${sessionId}:`, error);
		return [];
	}
}

/**
 * Extract content from a message (handles both user and assistant message types)
 */
function getMessageContent(message: {
	content: string | ContentBlock[];
}): ContentBlock[] {
	const content = message.content;
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return content as ContentBlock[];
}

/**
 * Convert Claude JSONL message to UIMessage format with comprehensive content support
 */
function claudeMessageToUIMessage(
	record:
		| (UserMessageRecord & { uuid: string })
		| (AssistantMessageRecord & { uuid: string })
		| (MessageRecord & { uuid: string }),
	toolResults: Map<string, ToolResultBlock>,
): UIMessage | null {
	if (!record.message) return null;

	const role =
		"role" in record.message
			? record.message.role === "assistant"
				? "assistant"
				: "user"
			: "assistant";
	const parts: UIMessage["parts"] = [];

	const content = getMessageContent(record.message);

	// Process content blocks in order
	for (const block of content) {
		if (block.type === "text") {
			// Add text content
			parts.push({
				type: "text",
				text: block.text,
			});
		} else if (block.type === "thinking") {
			// Add thinking/reasoning content (extended thinking feature)
			parts.push({
				type: "reasoning",
				text: block.thinking,
			});
		} else if (block.type === "tool_use") {
			// Add tool call with optional result
			const toolResult = toolResults.get(block.id);

			const toolPart: any = {
				type: "dynamic-tool",
				toolCallId: block.id,
				toolName: block.name,
				state: toolResult ? "output-available" : "input-available",
				input: block.input,
			};

			// Include tool result if available
			if (toolResult) {
				if (toolResult.is_error) {
					toolPart.state = "output-error";
					toolPart.errorText =
						typeof toolResult.content === "string"
							? toolResult.content
							: JSON.stringify(toolResult.content);
				} else {
					toolPart.output =
						typeof toolResult.content === "string"
							? toolResult.content
							: JSON.stringify(toolResult.content);
				}
			}

			parts.push(toolPart);
		}
		// Skip tool_result blocks as they're merged into tool_use
	}

	if (parts.length === 0) return null;

	return {
		id: record.uuid,
		role,
		parts,
	};
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
	} catch (_error) {
		return null;
	}
}

/**
 * Load full session data including progress records and metadata
 */
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
	progress?: Array<{
		type: string;
		timestamp?: string;
		data?: unknown;
	}>;
}

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

		const messages: UIMessage[] = [];
		const progress: SessionData["progress"] = [];
		const toolResults = new Map<string, ToolResultBlock>();

		let gitBranch: string | undefined;
		let version: string | undefined;

		// First pass: collect metadata and tool results
		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const record = JSON.parse(line) as ClaudeJSONLRecord;

				// Extract metadata (only from records that have these fields)
				if (record.type !== "queue-operation") {
					if (!gitBranch && "gitBranch" in record && record.gitBranch) {
						gitBranch = record.gitBranch;
					}
					if (!version && "version" in record && record.version) {
						version = record.version;
					}
				}

				// Collect tool results
				if (
					(record.type === "user" ||
						record.type === "assistant" ||
						record.type === "message") &&
					"message" in record &&
					record.message
				) {
					const content = getMessageContent(record.message);
					for (const block of content) {
						if (block.type === "tool_result") {
							toolResults.set(block.tool_use_id, block);
						}
					}
				}

				// Collect progress records
				if (record.type === "progress" && "data" in record) {
					progress.push({
						type: record.data?.type || "unknown",
						timestamp: record.timestamp,
						data: record.data,
					});
				}
			} catch (_error) {
				// Skip invalid lines
			}
		}

		// Second pass: build messages
		for (const line of lines) {
			if (!line.trim()) continue;

			try {
				const record = JSON.parse(line) as ClaudeJSONLRecord;

				// Process user and assistant messages (only if they have a uuid)
				if (
					(record.type === "user" ||
						record.type === "assistant" ||
						record.type === "message") &&
					"message" in record &&
					record.message &&
					record.uuid
				) {
					const uiMessage = claudeMessageToUIMessage(
						record as (
							| UserMessageRecord
							| AssistantMessageRecord
							| MessageRecord
						) & {
							uuid: string;
						},
						toolResults,
					);
					if (uiMessage) {
						messages.push(uiMessage);
					}
				}
			} catch (_error) {
				// Skip invalid lines
			}
		}

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
			progress,
		};
	} catch (error) {
		console.warn(`Failed to load full session data:`, error);
		return null;
	}
}
