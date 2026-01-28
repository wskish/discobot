import useSWR, { mutate } from "swr";
import { api } from "../api-client";
import type { Session, UpdateSessionRequest } from "../api-types";

// SWR key helpers
const getSessionKey = (sessionId: string) => `session-${sessionId}`;
const getSessionsKeyPrefix = () => "sessions-";

/**
 * Invalidate a single session's cache, triggering a refetch.
 */
export function invalidateSession(sessionId: string) {
	mutate(getSessionKey(sessionId));
}

/**
 * Remove a session from the cache without refetching.
 */
export function removeSessionFromCache(sessionId: string) {
	// Clear the individual session cache
	mutate(getSessionKey(sessionId), undefined, { revalidate: false });

	// Remove from all sessions-{workspaceId} caches
	mutate(
		(key: string) =>
			typeof key === "string" && key.startsWith(getSessionsKeyPrefix()),
		(current: { sessions: Session[] } | undefined) => {
			if (!current) return current;
			return {
				...current,
				sessions: current.sessions.filter(
					(session: Session) => session.id !== sessionId,
				),
			};
		},
		{ revalidate: false },
	);
}

/**
 * Invalidate all sessions caches, triggering refetches.
 */
export function invalidateAllSessionsCaches() {
	mutate(
		(key: string) =>
			typeof key === "string" && key.startsWith(getSessionsKeyPrefix()),
	);
}

export function useSessions(
	workspaceId: string | null,
	options?: { includeClosed?: boolean },
) {
	const includeClosed = options?.includeClosed ?? false;
	const { data, error, isLoading, mutate } = useSWR(
		workspaceId ? `sessions-${workspaceId}-${includeClosed}` : null,
		() =>
			workspaceId ? api.getSessions(workspaceId, { includeClosed }) : null,
	);

	return {
		sessions: data?.sessions || [],
		isLoading,
		error,
		mutate,
	};
}

export function useSession(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `session-${sessionId}` : null,
		() => (sessionId ? api.getSession(sessionId) : null),
	);

	const updateSession = async (data: UpdateSessionRequest) => {
		if (!sessionId) return;
		const session = await api.updateSession(sessionId, data);
		// Mutate the individual session cache
		mutate();
		// Also invalidate all sessions list caches so the updated name appears immediately
		invalidateAllSessionsCaches();
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
	/**
	 * Delete a session. The session will transition to "removing" state
	 * and be removed from the cache when the SSE event with status=removed arrives.
	 * @param sessionId - The session ID to delete
	 */
	const deleteSession = async (sessionId: string) => {
		await api.deleteSession(sessionId);
		// Don't invalidate caches here - the session will show "removing" state
		// and be removed from cache when we receive the session_updated event
		// with status=removed via SSE
	};

	return { deleteSession };
}
