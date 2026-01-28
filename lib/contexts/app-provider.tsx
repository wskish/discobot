"use client";

import type * as React from "react";
import { MainPanelProvider } from "./main-panel-context";
import { ProjectEventsProvider } from "./project-events-context";

interface AppProviderProps {
	children: React.ReactNode;
}

/**
 * Combined provider that wraps all domain contexts.
 * - ProjectEventsProvider: SSE connection for real-time updates
 * - MainPanelProvider: Main panel view state and session data
 */
export function AppProvider({ children }: AppProviderProps) {
	return (
		<ProjectEventsProvider>
			<MainPanelProvider>{children}</MainPanelProvider>
		</ProjectEventsProvider>
	);
}
