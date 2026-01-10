"use client";

import useSWR from "swr";
import { api } from "../api-client";
import type { CreateSessionRequest, UpdateSessionRequest } from "../api-types";
import { useWorkspaces } from "./use-workspaces";

export function useSession(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `session-${sessionId}` : null,
		() => (sessionId ? api.getSession(sessionId) : null),
	);

	const updateSession = async (data: UpdateSessionRequest) => {
		if (!sessionId) return;
		const session = await api.updateSession(sessionId, data);
		mutate();
		return session;
	};

	return {
		session: data,
		isLoading,
		error,
		updateSession,
		mutate,
	};
}

export function useCreateSession() {
	const { mutate: mutateWorkspaces } = useWorkspaces();

	const createSession = async (
		workspaceId: string,
		data: CreateSessionRequest,
	) => {
		const session = await api.createSession(workspaceId, data);
		mutateWorkspaces();
		return session;
	};

	return { createSession };
}

export function useDeleteSession() {
	const { mutate: mutateWorkspaces } = useWorkspaces();

	const deleteSession = async (sessionId: string) => {
		await api.deleteSession(sessionId);
		mutateWorkspaces();
	};

	return { deleteSession };
}
