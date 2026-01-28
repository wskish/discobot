import type { UIMessage } from "ai";
import useSWR from "swr";
import { api } from "../api-client";

// Stable empty array to avoid creating new references on every render
const EMPTY_MESSAGES: UIMessage[] = [];

export function useMessages(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `messages-${sessionId}` : null,
		() => (sessionId ? api.getMessages(sessionId) : null),
	);

	return {
		messages: data?.messages ?? EMPTY_MESSAGES,
		isLoading,
		error,
		mutate,
	};
}
