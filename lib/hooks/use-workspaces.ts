"use client";

import useSWR from "swr";
import { api } from "../api-client";
import type { CreateWorkspaceRequest, Workspace } from "../api-types";

export function useWorkspaces() {
	const { data, error, isLoading, mutate } = useSWR("workspaces", () =>
		api.getWorkspaces(),
	);

	const createWorkspace = async (data: CreateWorkspaceRequest) => {
		const workspace = await api.createWorkspace(data);
		mutate();
		return workspace;
	};

	const deleteWorkspace = async (id: string, deleteFiles = false) => {
		await api.deleteWorkspace(id, deleteFiles);
		mutate();
	};

	const updateWorkspace = async (id: string, data: Partial<Workspace>) => {
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
