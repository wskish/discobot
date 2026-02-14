import * as React from "react";
import { api } from "@/lib/api-client";
import type { StartupTask } from "@/lib/api-types";
import { StartupStatusContext } from "@/lib/contexts/startup-status-context";
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
 * Handles SWR cache mutations when session or workspace events are received,
 * and tracks startup task state from SSE events.
 */
export function ProjectEventsProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [tasksMap, setTasksMap] = React.useState<Map<string, StartupTask>>(
		new Map(),
	);

	// Fetch initial status once on mount to catch tasks already in progress
	React.useEffect(() => {
		api.getSystemStatus().then((status) => {
			if (status.startupTasks?.length) {
				setTasksMap((prev) => {
					const next = new Map(prev);
					for (const task of status.startupTasks ?? []) {
						next.set(task.id, task);
					}
					return next;
				});
			}
		});
	}, []);

	const handleSessionUpdated = React.useCallback((data: SessionUpdatedData) => {
		if (data.status === "removed") {
			removeSessionFromCache(data.sessionId);
		} else {
			invalidateSession(data.sessionId);
			invalidateAllSessionsCaches();
		}
	}, []);

	const handleWorkspaceUpdated = React.useCallback(
		(_data: WorkspaceUpdatedData) => {
			invalidateWorkspaces();
		},
		[],
	);

	const handleStartupTaskUpdated = React.useCallback((task: StartupTask) => {
		setTasksMap((prev) => {
			const next = new Map(prev);
			next.set(task.id, task);
			return next;
		});
	}, []);

	useProjectEvents({
		onSessionUpdated: handleSessionUpdated,
		onWorkspaceUpdated: handleWorkspaceUpdated,
		onStartupTaskUpdated: handleStartupTaskUpdated,
	});

	const tasks = React.useMemo(() => Array.from(tasksMap.values()), [tasksMap]);
	const hasActiveTasks = React.useMemo(
		() => tasks.some((t) => t.state === "pending" || t.state === "in_progress"),
		[tasks],
	);
	const startupStatus = React.useMemo(
		() => ({ tasks, hasActiveTasks }),
		[tasks, hasActiveTasks],
	);

	return (
		<StartupStatusContext value={startupStatus}>
			{children}
		</StartupStatusContext>
	);
}
