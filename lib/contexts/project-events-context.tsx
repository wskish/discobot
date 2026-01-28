import * as React from "react";
import {
	type SessionUpdatedData,
	useProjectEvents,
	type WorkspaceUpdatedData,
} from "@/lib/hooks/use-project-events";
import {
	invalidateAllSessionsCaches,
	invalidateSession,
	removeSessionFromCache,
} from "@/lib/hooks/use-sessions";
import { invalidateWorkspaces } from "@/lib/hooks/use-workspaces";

/**
 * Provider that manages the SSE connection for project events.
 * Handles SWR cache mutations when session or workspace events are received.
 */
export function ProjectEventsProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const handleSessionUpdated = React.useCallback((data: SessionUpdatedData) => {
		if (data.status === "removed") {
			// Session was deleted - remove it from cache instead of refetching
			removeSessionFromCache(data.sessionId);
		} else {
			// Session was updated - trigger SWR mutations to refresh data
			invalidateSession(data.sessionId);
			// Also invalidate sessions-{workspaceId} caches used by sidebar
			invalidateAllSessionsCaches();
		}
	}, []);

	const handleWorkspaceUpdated = React.useCallback(
		(_data: WorkspaceUpdatedData) => {
			// Trigger SWR mutations to refresh workspace data
			invalidateWorkspaces();
		},
		[],
	);

	useProjectEvents({
		onSessionUpdated: handleSessionUpdated,
		onWorkspaceUpdated: handleWorkspaceUpdated,
	});

	return <>{children}</>;
}
