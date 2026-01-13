"use client";

import { useCallback, useEffect, useRef } from "react";
import { mutate } from "swr";
import { getApiBase } from "../api-config";

// Event types from the server
export type ProjectEventType = "session_updated" | "workspace_updated";

export interface ProjectEvent {
	id: string;
	type: ProjectEventType;
	timestamp: string;
	data: unknown;
}

export interface SessionUpdatedData {
	sessionId: string;
	status: string;
}

export interface WorkspaceUpdatedData {
	workspaceId: string;
	status: string;
}

interface UseProjectEventsOptions {
	/** Called when a session_updated event is received */
	onSessionUpdated?: (data: SessionUpdatedData) => void;
	/** Called when a workspace_updated event is received */
	onWorkspaceUpdated?: (data: WorkspaceUpdatedData) => void;
	/** Whether to auto-reconnect on disconnect (default: true) */
	autoReconnect?: boolean;
	/** Reconnect delay in ms (default: 3000) */
	reconnectDelay?: number;
	/** RFC3339 timestamp to get events after (e.g., "2024-01-15T10:30:00Z") */
	since?: string;
	/** Event ID to get events after (alternative to since) */
	afterEventId?: string;
}

/**
 * Hook that subscribes to server-sent events for the current project.
 * Automatically triggers SWR mutations when session events are received.
 */
export function useProjectEvents(options: UseProjectEventsOptions = {}) {
	const {
		onSessionUpdated,
		onWorkspaceUpdated,
		autoReconnect = true,
		reconnectDelay = 3000,
		since,
		afterEventId,
	} = options;

	const eventSourceRef = useRef<EventSource | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const isConnectedRef = useRef(false);

	const connect = useCallback(() => {
		// Don't connect if already connected
		if (eventSourceRef.current?.readyState === EventSource.OPEN) {
			return;
		}

		// Close existing connection if any
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
		}

		// Build URL with query parameters
		const params = new URLSearchParams();
		if (afterEventId) {
			params.set("after", afterEventId);
		} else if (since) {
			params.set("since", since);
		}
		const queryString = params.toString();
		const url = `${getApiBase()}/events${queryString ? `?${queryString}` : ""}`;
		const eventSource = new EventSource(url);
		eventSourceRef.current = eventSource;

		eventSource.onopen = () => {
			isConnectedRef.current = true;
			console.log("[SSE] Connected to project events");
		};

		eventSource.onerror = (error) => {
			console.error("[SSE] Connection error:", error);
			isConnectedRef.current = false;

			// Close the connection
			eventSource.close();
			eventSourceRef.current = null;

			// Auto-reconnect
			if (autoReconnect && !reconnectTimeoutRef.current) {
				console.log(`[SSE] Reconnecting in ${reconnectDelay}ms...`);
				reconnectTimeoutRef.current = setTimeout(() => {
					reconnectTimeoutRef.current = null;
					connect();
				}, reconnectDelay);
			}
		};

		// Handle connected event (initial connection confirmation)
		eventSource.addEventListener("connected", (event) => {
			try {
				const data = JSON.parse(event.data);
				console.log("[SSE] Connection confirmed for project:", data.projectId);
			} catch {
				// Ignore parse errors for connected event
			}
		});

		// Handle session_updated events
		eventSource.addEventListener("session_updated", (event) => {
			try {
				const payload: ProjectEvent = JSON.parse(event.data);
				const sessionData = payload.data as SessionUpdatedData;

				console.log(
					"[SSE] Session updated:",
					sessionData.sessionId,
					"->",
					sessionData.status,
				);

				// Trigger SWR mutations to refresh session data
				// Mutate the specific session
				mutate(`session-${sessionData.sessionId}`);

				// Also mutate workspaces since sessions are nested
				mutate("workspaces");

				// Call the callback if provided
				onSessionUpdated?.(sessionData);
			} catch (err) {
				console.error("[SSE] Failed to parse session_updated event:", err);
			}
		});

		// Handle workspace_updated events
		eventSource.addEventListener("workspace_updated", (event) => {
			try {
				const payload: ProjectEvent = JSON.parse(event.data);
				const workspaceData = payload.data as WorkspaceUpdatedData;

				console.log(
					"[SSE] Workspace updated:",
					workspaceData.workspaceId,
					"->",
					workspaceData.status,
				);

				// Trigger SWR mutations to refresh workspace data
				mutate("workspaces");

				// Call the callback if provided
				onWorkspaceUpdated?.(workspaceData);
			} catch (err) {
				console.error("[SSE] Failed to parse workspace_updated event:", err);
			}
		});
	}, [
		autoReconnect,
		reconnectDelay,
		onSessionUpdated,
		onWorkspaceUpdated,
		since,
		afterEventId,
	]);

	const disconnect = useCallback(() => {
		// Clear reconnect timeout
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
			reconnectTimeoutRef.current = null;
		}

		// Close connection
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
			eventSourceRef.current = null;
			isConnectedRef.current = false;
			console.log("[SSE] Disconnected from project events");
		}
	}, []);

	// Connect on mount, disconnect on unmount
	useEffect(() => {
		connect();

		return () => {
			disconnect();
		};
	}, [connect, disconnect]);

	return {
		/** Whether currently connected to the event stream */
		isConnected: isConnectedRef.current,
		/** Manually reconnect to the event stream */
		reconnect: connect,
		/** Manually disconnect from the event stream */
		disconnect,
	};
}
