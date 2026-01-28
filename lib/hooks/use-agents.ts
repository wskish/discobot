import useSWR from "swr";
import { api } from "../api-client";
import type { CreateAgentRequest, UpdateAgentRequest } from "../api-types";

export function useAgents() {
	const { data, error, isLoading, mutate } = useSWR("agents", () =>
		api.getAgents(),
	);

	const createAgent = async (data: CreateAgentRequest) => {
		const agent = await api.createAgent(data);
		mutate();
		return agent;
	};

	const updateAgent = async (id: string, data: UpdateAgentRequest) => {
		const agent = await api.updateAgent(id, data);
		mutate();
		return agent;
	};

	const deleteAgent = async (id: string) => {
		await api.deleteAgent(id);
		mutate();
	};

	const setDefaultAgent = async (id: string) => {
		const agent = await api.setDefaultAgent(id);
		// Don't await - revalidate in background to avoid blocking
		mutate();
		return agent;
	};

	return {
		agents: data?.agents || [],
		isLoading,
		error,
		createAgent,
		updateAgent,
		deleteAgent,
		setDefaultAgent,
		mutate,
	};
}
