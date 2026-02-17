import useSWR from "swr";
import { api } from "../api-client";

export function useAgentModels(agentId: string | null) {
	const { data, error, isLoading } = useSWR(
		agentId ? `agent-models-${agentId}` : null,
		() => (agentId ? api.getAgentModels(agentId) : null),
	);

	return {
		models: data?.models || [],
		isLoading,
		error,
	};
}

export function useSessionModels(sessionId: string | null) {
	const { data, error, isLoading } = useSWR(
		sessionId ? `session-models-${sessionId}` : null,
		() => (sessionId ? api.getSessionModels(sessionId) : null),
	);

	return {
		models: data?.models || [],
		isLoading,
		error,
	};
}
