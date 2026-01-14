"use client";

import useSWR from "swr";
import { api } from "../api-client";
import type { UpdateSessionRequest } from "../api-types";
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

// NOTE: useCreateSession removed - sessions are created implicitly via /chat endpoint

export function useDeleteSession() {
	const { mutate: mutateWorkspaces } = useWorkspaces();

	const deleteSession = async (sessionId: string) => {
		await api.deleteSession(sessionId);
		mutateWorkspaces();
	};

	return { deleteSession };
}
