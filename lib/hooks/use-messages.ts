import type { UIMessage } from "ai";
import useSWR from "swr";
import { api } from "../api-client";

// Stable empty array to avoid creating new references on every render
const EMPTY_MESSAGES: UIMessage[] = [];

/**
 * Deduplicates messages by ID and logs a warning if duplicates are found.
 * This is used in SWR's onSuccess callback to clean data after fetch.
 */
function deduplicateMessages(
	messages: UIMessage[],
	sessionId: string,
): UIMessage[] {
	const seen = new Set<string>();
	const deduped: UIMessage[] = [];
	const duplicates: string[] = [];

	for (const msg of messages) {
		if (!seen.has(msg.id)) {
			seen.add(msg.id);
			deduped.push(msg);
		} else {
			duplicates.push(msg.id);
		}
	}

	if (duplicates.length > 0) {
		console.warn(
			`[useMessages] Deduplicating messages for session ${sessionId}. Found ${duplicates.length} duplicate(s): ${duplicates.join(", ")}`,
		);
	}

	return deduped;
}

export function useMessages(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `messages-${sessionId}` : null,
		() => (sessionId ? api.getMessages(sessionId) : null),
		{
			// Use onSuccess to deduplicate messages after fetch
			onSuccess: (data) => {
				if (data?.messages && sessionId) {
					data.messages = deduplicateMessages(data.messages, sessionId);
				}
			},
		},
	);

	return {
		messages: data?.messages ?? EMPTY_MESSAGES,
		isLoading,
		error,
		mutate,
	};
}
