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
 *   GET  /chat/status - Get completion status
 *   DELETE /chat      - Clear session and messages
 */

import type { UIMessage } from "ai";

// ============================================================================
// Request Types
// ============================================================================

/**
 * POST /chat request body
 */
export interface ChatRequest {
	messages: UIMessage[];
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
 * GET /chat/status response
 */
export interface ChatStatusResponse {
	isRunning: boolean;
	completionId: string | null;
	startedAt: string | null;
	error: string | null;
}

/**
 * Error response (4xx/5xx)
 */
export interface ErrorResponse {
	error: string;
}
