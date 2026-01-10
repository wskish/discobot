"use client";

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

	const duplicateAgent = async (id: string) => {
		const agent = await api.duplicateAgent(id);
		mutate();
		return agent;
	};

	return {
		agents: data || [],
		isLoading,
		error,
		createAgent,
		updateAgent,
		deleteAgent,
		duplicateAgent,
		mutate,
	};
}
