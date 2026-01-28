import useSWR from "swr";
import { api } from "../api-client";

export function useSuggestions(query: string, type?: "path" | "repo") {
	const { data, error, isLoading } = useSWR(
		query.length >= 1 ? `suggestions-${query}-${type}` : null,
		() => api.getSuggestions(query, type),
		{ dedupingInterval: 300 },
	);

	return {
		suggestions: data?.suggestions || [],
		isLoading,
		error,
	};
}
