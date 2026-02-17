/**
 * Sandbox API Types
 *
 * This file defines the request/response types for the sandbox HTTP API.
 * These types must be kept in sync with the Go server's sandbox API types
 * located at: server/internal/sandbox/sandboxapi/types.go
 *
 * API Endpoints:
 *   GET  /            - Health check
 *   GET  /health      - Detailed health status
 *   GET  /chat        - Get all messages
 *   POST /chat        - Start completion (returns 202 Accepted, runs in background)
 *   POST /chat/cancel - Cancel in-progress completion
 *   GET  /chat/status - Get completion status
 *   DELETE /chat      - Clear session and messages
 */

import type { UIMessage, UIMessageChunk } from "ai";

// Re-export AI SDK types for convenience
export type { UIMessage, UIMessageChunk };

// ============================================================================
// Request Types
// ============================================================================

/**
 * POST /chat request body
 */
export interface ChatRequest {
	messages: UIMessage[];
	model?: string;
	/** Extended thinking: "enabled", "disabled", or undefined for default */
	reasoning?: "enabled" | "disabled" | "";
}

// ============================================================================
// Response Types
// ============================================================================

/**
 * GET / response
 */
export interface RootResponse {
	status: "ok";
	service: "agent";
}

/**
 * GET /health response
 */
export interface HealthResponse {
	healthy: boolean;
	connected: boolean;
}

/**
 * GET /user response - default user info for terminal sessions
 */
export interface UserResponse {
	username: string;
	uid: number;
	gid: number;
}

/**
 * GET /chat response
 */
export interface GetMessagesResponse {
	messages: UIMessage[];
}

/**
 * DELETE /chat response
 */
export interface ClearSessionResponse {
	success: boolean;
}

/**
 * POST /chat response (202 Accepted)
 * The completion runs in the background. Poll GET /chat for messages.
 */
export interface ChatStartedResponse {
	completionId: string;
	status: "started";
}

/**
 * POST /chat response (409 Conflict)
 * Returned when a completion is already in progress.
 */
export interface ChatConflictResponse {
	error: "completion_in_progress";
	completionId: string;
}

/**
 * POST /chat/cancel response (200 OK)
 * Returned when cancellation is successful.
 */
export interface CancelCompletionResponse {
	success: true;
	completionId: string;
	status: "cancelled";
}

/**
 * POST /chat/cancel response (409 Conflict)
 * Returned when no completion is active to cancel.
 */
export interface NoActiveCompletionResponse {
	error: "no_active_completion";
}

/**
 * GET /chat/status response
 */
export interface ChatStatusResponse {
	isRunning: boolean;
	completionId: string | null;
	startedAt: string | null;
	error: string | null;
}

/**
 * Model information from Anthropic API
 */
export interface ModelInfo {
	id: string;
	display_name: string;
	provider: string;
	created_at: string;
	type: string;
	/** Whether this model supports extended thinking/reasoning */
	reasoning: boolean;
}

/**
 * GET /models response - list available models from Claude API
 */
export interface ModelsResponse {
	models: ModelInfo[];
}

/**
 * Error response (4xx/5xx)
 */
export interface ErrorResponse {
	error: string;
}

// ============================================================================
// File System Types
// ============================================================================

/**
 * Single file entry in a directory listing
 */
export interface FileEntry {
	name: string;
	type: "file" | "directory";
	size?: number; // Only for files
}

/**
 * GET /files response - directory listing
 */
export interface ListFilesResponse {
	path: string;
	entries: FileEntry[];
}

/**
 * GET /files/read response - file content
 */
export interface ReadFileResponse {
	path: string;
	content: string;
	encoding: "utf8" | "base64";
	size: number;
}

/**
 * POST /files/write request body
 */
export interface WriteFileRequest {
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
}

/**
 * POST /files/write response
 */
export interface WriteFileResponse {
	path: string;
	size: number;
}

/**
 * Single file diff entry
 */
export interface FileDiffEntry {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldPath?: string; // For renamed files
	additions: number;
	deletions: number;
	binary: boolean;
	patch?: string; // Unified diff content
}

/**
 * Diff stats summary
 */
export interface DiffStats {
	filesChanged: number;
	additions: number;
	deletions: number;
}

/**
 * GET /diff response - full diff with patches
 */
export interface DiffResponse {
	files: FileDiffEntry[];
	stats: DiffStats;
}

/**
 * File entry with status for files-only diff response
 */
export interface DiffFileEntry {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldPath?: string; // For renamed files
}

/**
 * GET /diff?format=files response - file paths with status
 */
export interface DiffFilesResponse {
	files: DiffFileEntry[];
	stats: DiffStats;
}

/**
 * GET /diff?path=... response - single file diff
 */
export interface SingleFileDiffResponse {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	patch: string;
}

// ============================================================================
// Git Commits Types (for commit workflow)
// ============================================================================

/**
 * GET /commits response - success case
 * Returns git format-patch output for commits since a parent
 */
export interface CommitsResponse {
	/** Git format-patch output (mbox format) containing all commits */
	patches: string;
	/** Number of commits included in patches */
	commitCount: number;
}

/**
 * GET /commits error responses
 */
export interface CommitsErrorResponse {
	error: "parent_mismatch" | "no_commits" | "invalid_parent" | "not_git_repo";
	message: string;
}

// ============================================================================
// Service Types
// ============================================================================

/**
 * Service configuration parsed from YAML front matter
 */
export interface ServiceConfig {
	/** Display name (defaults to filename if not specified) */
	name?: string;
	/** Description of the service */
	description?: string;
	/** HTTP port if this is an HTTP service */
	http?: number;
	/** HTTPS port if this is an HTTPS service */
	https?: number;
	/**
	 * Default URL path for the web preview (e.g., "/app" or "/api/docs").
	 * Defaults to "/" if not specified.
	 */
	urlPath?: string;
	/**
	 * Whether this is a passive service (external HTTP endpoint).
	 * Passive services are not started/stopped by the agent - they just
	 * declare an HTTP port that's managed externally.
	 * Detected automatically when the service file has no executable body.
	 */
	passive?: boolean;
}

/**
 * Service runtime status
 */
export type ServiceStatus = "running" | "stopped" | "starting" | "stopping";

/**
 * Service definition with runtime state.
 * The `id` is ALWAYS the filename in .discobot/services/ and is used in all API routes.
 * The `name` field from front matter is for display purposes only.
 */
export interface Service {
	/** Filename in .discobot/services/ (immutable identifier used in routes) */
	id: string;
	/** Display name (from config, defaults to id) */
	name: string;
	/** Description (from config) */
	description?: string;
	/** HTTP port if http service */
	http?: number;
	/** HTTPS port if https service */
	https?: number;
	/** Absolute path to the service file */
	path: string;
	/**
	 * Default URL path for the web preview (e.g., "/app" or "/api/docs").
	 * Defaults to "/" if not specified.
	 */
	urlPath?: string;
	/** Current status */
	status: ServiceStatus;
	/**
	 * Whether this is a passive service (external HTTP endpoint).
	 * Passive services are not started/stopped - they just declare an HTTP port.
	 */
	passive?: boolean;
	/** PID if running */
	pid?: number;
	/** Start time (ISO string) */
	startedAt?: string;
	/** Exit code if stopped after running */
	exitCode?: number;
}

/**
 * GET /services response
 */
export interface ListServicesResponse {
	services: Service[];
}

/**
 * POST /services/:id/start response (202 Accepted)
 */
export interface StartServiceResponse {
	status: "starting";
	serviceId: string;
}

/**
 * POST /services/:id/stop response
 */
export interface StopServiceResponse {
	status: "stopped";
	serviceId: string;
}

/**
 * Service output event (for SSE streaming)
 */
export interface ServiceOutputEvent {
	/** Event type */
	type: "stdout" | "stderr" | "exit" | "error";
	/** Output data (for stdout/stderr) */
	data?: string;
	/** Exit code (for exit event) */
	exitCode?: number;
	/** Error message (for error event) */
	error?: string;
	/** Timestamp */
	timestamp: string;
}

/**
 * Error when service not found
 */
export interface ServiceNotFoundResponse {
	error: "service_not_found";
	serviceId: string;
}

/**
 * Error when service already running
 */
export interface ServiceAlreadyRunningResponse {
	error: "service_already_running";
	serviceId: string;
	pid: number;
}

/**
 * Error when service not running
 */
export interface ServiceNotRunningResponse {
	error: "service_not_running";
	serviceId: string;
}

/**
 * Error when service has no HTTP/HTTPS port for connect API
 */
export interface ServiceNoPortResponse {
	error: "service_no_port";
	serviceId: string;
}

/**
 * Error when trying to start/stop/get output from a passive service.
 * Passive services are externally managed and don't have a process to control.
 */
export interface ServiceIsPassiveResponse {
	error: "service_is_passive";
	serviceId: string;
	message: string;
}

/**
 * Error when proxy cannot connect to the service port (connection refused)
 * HTTP 503 Service Unavailable
 */
export interface ServiceConnectionRefusedResponse {
	error: "connection_refused";
	message: string;
	port: number;
}

/**
 * Generic proxy error
 * HTTP 502 Bad Gateway
 */
export interface ServiceProxyErrorResponse {
	error: "proxy_error";
	message: string;
	port: number;
}
