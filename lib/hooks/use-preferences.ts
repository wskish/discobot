import { useCallback } from "react";
import useSWR from "swr";
import { api } from "../api-client";
import type { UserPreference } from "../api-types";

export function usePreferences() {
	const { data, error, isLoading, mutate } = useSWR("preferences", () =>
		api.getPreferences(),
	);

	/**
	 * Get a preference value by key from the local cache.
	 * Returns undefined if not found.
	 */
	const getPreference = useCallback(
		(key: string): string | undefined => {
			return data?.preferences.find((p) => p.key === key)?.value;
		},
		[data?.preferences],
	);

	/**
	 * Set a single preference.
	 * Updates the server and revalidates the cache.
	 */
	const setPreference = async (
		key: string,
		value: string,
	): Promise<UserPreference> => {
		const pref = await api.setPreference(key, value);
		mutate();
		return pref;
	};

	/**
	 * Set multiple preferences at once.
	 * Updates the server and revalidates the cache.
	 */
	const setPreferences = async (
		preferences: Record<string, string>,
	): Promise<UserPreference[]> => {
		const result = await api.setPreferences(preferences);
		mutate();
		return result.preferences;
	};

	/**
	 * Delete a preference by key.
	 * Removes from the server and revalidates the cache.
	 */
	const deletePreference = async (key: string): Promise<void> => {
		await api.deletePreference(key);
		mutate();
	};

	return {
		preferences: data?.preferences || [],
		isLoading,
		error,
		getPreference,
		setPreference,
		setPreferences,
		deletePreference,
		mutate,
	};
}
