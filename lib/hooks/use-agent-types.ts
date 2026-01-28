import useSWR from "swr";
import { api } from "../api-client";
import type { SupportedAgentType } from "../api-types";

interface AgentTypesResponse {
	agentTypes: SupportedAgentType[];
}

export function useAgentTypes() {
	const { data, error, isLoading } = useSWR<AgentTypesResponse>(
		"agent-types",
		() => api.getAgentTypes(),
	);

	return {
		agentTypes: data?.agentTypes || [],
		isLoading,
		error,
	};
}
