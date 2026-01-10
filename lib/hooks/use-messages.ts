"use client";

import useSWR from "swr";
import { api } from "../api-client";

export function useMessages(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `messages-${sessionId}` : null,
		() => (sessionId ? api.getMessages(sessionId) : []),
	);

	return {
		messages: data || [],
		isLoading,
		error,
		mutate,
	};
}
