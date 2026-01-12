"use client";

import useSWR from "swr";
import { api } from "../api-client";
import type { CreateCredentialRequest } from "../api-types";

/**
 * Hook for managing API credentials
 *
 * Provides CRUD operations for credentials.
 * OAuth flows are handled by auth plugins directly.
 */
export function useCredentials() {
	const { data, error, isLoading, mutate } = useSWR("credentials", () =>
		api.getCredentials(),
	);

	const createCredential = async (data: CreateCredentialRequest) => {
		const credential = await api.createCredential(data);
		mutate();
		return credential;
	};

	const deleteCredential = async (providerId: string) => {
		await api.deleteCredential(providerId);
		mutate();
	};

	return {
		credentials: data?.credentials || [],
		isLoading,
		error,
		createCredential,
		deleteCredential,
		mutate,
	};
}
