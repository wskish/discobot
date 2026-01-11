"use client";

import * as React from "react";

/**
 * A useState hook that persists the value to localStorage.
 * Handles SSR by only reading localStorage after mount.
 */
export function usePersistedState<T>(
	key: string,
	defaultValue: T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [state, setState] = React.useState<T>(defaultValue);
	const [isHydrated, setIsHydrated] = React.useState(false);

	// Load from localStorage after mount (to avoid SSR mismatch)
	React.useEffect(() => {
		try {
			const stored = localStorage.getItem(key);
			if (stored !== null) {
				setState(JSON.parse(stored));
			}
		} catch {
			// Ignore errors (e.g., invalid JSON)
		}
		setIsHydrated(true);
	}, [key]);

	// Save to localStorage whenever state changes (after hydration)
	React.useEffect(() => {
		if (isHydrated) {
			try {
				localStorage.setItem(key, JSON.stringify(state));
			} catch {
				// Ignore errors (e.g., quota exceeded)
			}
		}
	}, [key, state, isHydrated]);

	return [state, setState];
}

/**
 * Storage key prefix for panel layout settings
 */
export const STORAGE_KEYS = {
	LEFT_SIDEBAR_OPEN: "octobot:leftSidebarOpen",
	AGENTS_PANEL_MINIMIZED: "octobot:agentsPanelMinimized",
	AGENTS_PANEL_HEIGHT: "octobot:agentsPanelHeight",
	DIFF_PANEL_STATE: "octobot:diffPanelState",
	BOTTOM_PANEL_STATE: "octobot:bottomPanelState",
	DIFF_PANEL_HEIGHT: "octobot:diffPanelHeight",
} as const;
