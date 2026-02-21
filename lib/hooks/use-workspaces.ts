import useSWR, { mutate } from "swr";
import { api } from "../api-client";
import type { CreateWorkspaceRequest } from "../api-types";

// SWR keys
const WORKSPACES_KEY = "workspaces";
const SANDBOX_PROVIDERS_KEY = "sandbox-providers";

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
		// Immediately update cache with the new workspace so it's available
		// when navigating to the new session screen, then revalidate in background
		mutate(
			(current) => ({
				workspaces: [...(current?.workspaces || []), workspace],
			}),
			{ revalidate: true },
		);
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

export function useSandboxProviders() {
	const { data, error, isLoading } = useSWR(SANDBOX_PROVIDERS_KEY, () =>
		api.getProviders(),
	);

	return {
		providers: data?.providers ? Object.keys(data.providers) : [],
		providerStatuses: data?.providers || {},
		defaultProvider: data?.default || "",
		isLoading,
		error,
	};
}
