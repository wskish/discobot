import useSWR, { mutate } from "swr";
import { api } from "../api-client";
import type { CreateWorkspaceRequest } from "../api-types";

// SWR key for workspaces
const WORKSPACES_KEY = "workspaces";

/**
 * Invalidate the workspaces cache, triggering a refetch.
 */
export function invalidateWorkspaces() {
	mutate(WORKSPACES_KEY);
}

export function useWorkspaces() {
	const { data, error, isLoading, mutate } = useSWR(WORKSPACES_KEY, () =>
		api.getWorkspaces(),
	);

	const createWorkspace = async (data: CreateWorkspaceRequest) => {
		const workspace = await api.createWorkspace(data);
		// Don't await - revalidate in background to avoid blocking
		mutate();
		return workspace;
	};

	const deleteWorkspace = async (id: string, deleteFiles = false) => {
		await api.deleteWorkspace(id, deleteFiles);
		mutate();
	};

	const updateWorkspace = async (
		id: string,
		data: { path?: string; displayName?: string | null },
	) => {
		const workspace = await api.updateWorkspace(id, data);
		mutate();
		return workspace;
	};

	return {
		workspaces: data?.workspaces || [],
		isLoading,
		error,
		createWorkspace,
		deleteWorkspace,
		updateWorkspace,
		mutate,
	};
}
