"use client";

import * as React from "react";
import useSWR from "swr";
import { api } from "../api-client";
import type { AuthProvider } from "../api-types";

interface AuthProvidersResponse {
	authProviders: AuthProvider[];
}

/**
 * Hook that provides auth providers from the backend.
 * Auth providers are loaded from models.dev data embedded in the Go binary.
 */
export function useAuthProviders() {
	const { data, error, isLoading } = useSWR<AuthProvidersResponse>(
		"auth-providers",
		() => api.getAuthProviders(),
	);

	const authProviders = data?.authProviders || [];

	// Create a map for fast lookups by provider ID
	const providersMap = React.useMemo(() => {
		const map: Record<string, AuthProvider> = {};
		for (const provider of authProviders) {
			map[provider.id] = provider;
		}
		return map;
	}, [authProviders]);

	return {
		authProviders,
		// Alias for compatibility with components expecting useModelsProviders interface
		providers: authProviders,
		providersMap,
		isLoading,
		error,
	};
}

/**
 * Get the logo URL for a provider.
 * Returns the first icon src from the provider's icons array,
 * or falls back to models.dev logo URL.
 */
export function getAuthProviderLogoUrl(
	providerId: string,
	provider?: AuthProvider,
): string {
	// If provider has icons, use the first one
	if (provider?.icons?.[0]?.src) {
		return provider.icons[0].src;
	}
	// Fall back to models.dev logo URL
	return `https://models.dev/logos/${providerId}.svg`;
}
