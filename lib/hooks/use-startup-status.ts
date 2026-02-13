import useSWR from "swr";
import { api } from "../api-client";

const SYSTEM_STATUS_KEY = "system-status";

export function useStartupStatus() {
	const { data, error, isLoading } = useSWR(
		SYSTEM_STATUS_KEY,
		() => api.getSystemStatus(),
		{
			// Poll every 2 seconds to get real-time updates
			refreshInterval: 2000,
			// Stop polling if all tasks are completed or failed
			refreshWhenHidden: true,
			refreshWhenOffline: false,
		},
	);

	const tasks = data?.startupTasks || [];

	// Check if there are any active tasks (pending or in_progress)
	const hasActiveTasks = tasks.some(
		(task) => task.state === "pending" || task.state === "in_progress",
	);

	return {
		tasks,
		isLoading,
		error,
		hasActiveTasks,
	};
}
