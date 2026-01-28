import * as React from "react";

type StorageType = "local" | "session";

/**
 * A useState hook that persists the value to localStorage or sessionStorage.
 * Handles SSR by only reading storage after mount.
 *
 * @param storage - "local" for localStorage (shared across tabs), "session" for sessionStorage (per-tab)
 */
export function usePersistedState<T>(
	key: string,
	defaultValue: T,
	storage: StorageType = "local",
): [T, React.Dispatch<React.SetStateAction<T>>] {
	const [state, setState] = React.useState<T>(defaultValue);
	const [isHydrated, setIsHydrated] = React.useState(false);

	// Load from storage after mount (to avoid SSR mismatch)
	React.useEffect(() => {
		const store = storage === "local" ? localStorage : sessionStorage;
		try {
			const stored = store.getItem(key);
			if (stored !== null) {
				setState(JSON.parse(stored));
			}
		} catch {
			// Ignore errors (e.g., invalid JSON)
		}
		setIsHydrated(true);
	}, [key, storage]);

	// Save to storage whenever state changes (after hydration)
	React.useEffect(() => {
		if (isHydrated) {
			const store = storage === "local" ? localStorage : sessionStorage;
			try {
				store.setItem(key, JSON.stringify(state));
			} catch {
				// Ignore errors (e.g., quota exceeded)
			}
		}
	}, [key, state, isHydrated, storage]);

	return [state, setState];
}

/**
 * Storage key prefix for panel layout settings
 */
export const STORAGE_KEYS = {
	LEFT_SIDEBAR_OPEN: "octobot:leftSidebarOpen",
	LEFT_SIDEBAR_WIDTH: "octobot:leftSidebarWidth",
	RIGHT_SIDEBAR_OPEN: "octobot:rightSidebarOpen",
	RIGHT_SIDEBAR_WIDTH: "octobot:rightSidebarWidth",
	AGENTS_PANEL_MINIMIZED: "octobot:agentsPanelMinimized",
	AGENTS_PANEL_HEIGHT: "octobot:agentsPanelHeight",
	LAST_AGENT_TYPE_ID: "octobot:lastAgentTypeId",
	LAST_WORKSPACE_PATH: "octobot:lastWorkspacePath",
	// Session visibility
	SHOW_CLOSED_SESSIONS: "octobot:showClosedSessions",
	// Per-session state (sessionStorage)
	ACTIVE_VIEW: "octobot:activeView",
	OPEN_FILE_PATHS: "octobot:openFilePaths",
	ACTIVE_FILE_PATH: "octobot:activeFilePath",
	FILE_VIEW_MODES: "octobot:fileViewModes",
} as const;
