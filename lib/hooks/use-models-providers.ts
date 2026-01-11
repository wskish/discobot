import useSWR from "swr";

export interface ModelProvider {
	id: string;
	name: string;
	env: string[];
	npm?: string;
	api?: string | null;
	doc?: string;
	models: Record<string, ModelInfo> | string[];
}

export interface ModelInfo {
	id: string;
	name: string;
	family?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	modalities?: {
		input: string[];
		output: string[];
	};
	cost?: {
		input: number;
		output: number;
	};
	limit?: {
		context: number;
		output: number;
	};
}

export type ModelsApiData = Record<string, ModelProvider>;

// REMOTE_URL kept for reference - currently using local data to avoid CORS
// const REMOTE_URL = "https://models.dev/api.json";
const LOCAL_FALLBACK_URL = "/data/models-dev/api.json";

async function fetchModelsData(): Promise<ModelsApiData> {
	// Use local bundled data directly to avoid CORS issues with models.dev
	// The data is refreshed via the refresh-models-data.sh script
	const localResponse = await fetch(LOCAL_FALLBACK_URL);
	if (!localResponse.ok) {
		throw new Error("Failed to load models data");
	}
	return localResponse.json();
}

export function useModelsProviders() {
	const { data, error, isLoading } = useSWR<ModelsApiData>(
		"models-providers",
		fetchModelsData,
		{
			revalidateOnFocus: false,
			revalidateOnReconnect: true,
			dedupingInterval: 60000, // Cache for 1 minute
		},
	);

	const providers = data
		? Object.values(data).sort((a, b) => a.name.localeCompare(b.name))
		: [];

	return {
		providers,
		providersMap: data ?? {},
		isLoading,
		error,
	};
}

/**
 * Get the logo URL for a provider
 * Tries remote first, falls back to local bundled SVG
 */
export function getProviderLogoUrl(providerId: string): string {
	return `/data/models-dev/logos/${providerId}.svg`;
}

/**
 * Get remote logo URL (for when we want to try remote first)
 */
export function getRemoteProviderLogoUrl(providerId: string): string {
	return `https://models.dev/logos/${providerId}.svg`;
}
