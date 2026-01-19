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
}

/**
 * Hook that subscribes to server-sent events for the current project.
 * Automatically triggers SWR mutations when session events are received.
 *
 * This hook maintains a single persistent connection that survives re-renders.
 * Callbacks are stored in refs so changing them doesn't cause reconnection.
 */
export function useProjectEvents(options: UseProjectEventsOptions = {}) {
	const {
		onSessionUpdated,
		onWorkspaceUpdated,
		autoReconnect = true,
		reconnectDelay = 3000,
	} = options;

	const eventSourceRef = useRef<EventSource | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const isConnectedRef = useRef(false);

	// Store callbacks in refs so they don't cause reconnection when changed
	const onSessionUpdatedRef = useRef(onSessionUpdated);
	const onWorkspaceUpdatedRef = useRef(onWorkspaceUpdated);

	// Keep refs up to date
	useEffect(() => {
		onSessionUpdatedRef.current = onSessionUpdated;
	}, [onSessionUpdated]);

	useEffect(() => {
		onWorkspaceUpdatedRef.current = onWorkspaceUpdated;
	}, [onWorkspaceUpdated]);

	const connect = useCallback(() => {
		// Don't connect if already connected
		if (eventSourceRef.current?.readyState === EventSource.OPEN) {
			return;
		}

		// Close existing connection if any
		if (eventSourceRef.current) {
			eventSourceRef.current.close();
		}

		const url = `${getApiBase()}/events`;
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
				mutate(`session-${sessionData.sessionId}`);
				mutate("workspaces");

				// Call the callback if provided (using ref to get latest)
				onSessionUpdatedRef.current?.(sessionData);
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

				// Call the callback if provided (using ref to get latest)
				onWorkspaceUpdatedRef.current?.(workspaceData);
			} catch (err) {
				console.error("[SSE] Failed to parse workspace_updated event:", err);
			}
		});
	}, [autoReconnect, reconnectDelay]);

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
	// This effect only runs once since connect/disconnect have stable dependencies
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
