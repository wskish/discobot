import * as React from "react";
import type { Session } from "@/lib/api-types";
import { useSession } from "@/lib/hooks/use-sessions";

export type MainPanelView =
	| { type: "new-session"; workspaceId?: string; agentId?: string }
	| { type: "session"; sessionId: string }
	| { type: "workspace-sessions"; workspaceId: string };

export interface MainPanelContextValue {
	// Current view state
	view: MainPanelView;

	// Helper methods to get current IDs
	getSelectedSessionId: () => string | null;
	getSelectedWorkspaceId: () => string | null;

	// Session data and loading state
	selectedSession: Session | null | undefined;
	isSessionLoading: boolean;

	// Actions to change the view
	showNewSession: (options?: {
		workspaceId?: string;
		agentId?: string;
	}) => void;
	showSession: (sessionId: string) => void;
	showWorkspaceSessions: (workspaceId: string) => void;
}

const MainPanelContext = React.createContext<MainPanelContextValue | null>(
	null,
);

export function useMainPanelContext() {
	const context = React.useContext(MainPanelContext);
	if (!context) {
		throw new Error(
			"useMainPanelContext must be used within a MainPanelProvider",
		);
	}
	return context;
}

interface MainPanelProviderProps {
	children: React.ReactNode;
}

export function MainPanelProvider({ children }: MainPanelProviderProps) {
	const [view, setView] = React.useState<MainPanelView>({
		type: "new-session",
	});

	// Fetch session data when viewing a session
	const selectedSessionId = view.type === "session" ? view.sessionId : null;
	const { session: selectedSession, isLoading: isSessionLoading } =
		useSession(selectedSessionId);

	// Helper methods to get current IDs
	const getSelectedSessionId = React.useCallback(() => {
		return view.type === "session" ? view.sessionId : null;
	}, [view]);

	const getSelectedWorkspaceId = React.useCallback(() => {
		if (view.type === "workspace-sessions") {
			return view.workspaceId;
		}
		if (view.type === "new-session" && view.workspaceId) {
			return view.workspaceId;
		}
		// When viewing a session, return the workspace ID from the session
		if (view.type === "session") {
			return selectedSession?.workspaceId ?? null;
		}
		return null;
	}, [view, selectedSession]);

	// Actions
	const showNewSession = React.useCallback(
		(options?: { workspaceId?: string; agentId?: string }) => {
			setView({
				type: "new-session",
				workspaceId: options?.workspaceId,
				agentId: options?.agentId,
			});
		},
		[],
	);

	const showSession = React.useCallback((sessionId: string) => {
		setView({ type: "session", sessionId });
	}, []);

	const showWorkspaceSessions = React.useCallback((workspaceId: string) => {
		setView({ type: "workspace-sessions", workspaceId });
	}, []);

	const value = React.useMemo<MainPanelContextValue>(
		() => ({
			view,
			getSelectedSessionId,
			getSelectedWorkspaceId,
			selectedSession,
			isSessionLoading,
			showNewSession,
			showSession,
			showWorkspaceSessions,
		}),
		[
			view,
			getSelectedSessionId,
			getSelectedWorkspaceId,
			selectedSession,
			isSessionLoading,
			showNewSession,
			showSession,
			showWorkspaceSessions,
		],
	);

	return (
		<MainPanelContext.Provider value={value}>
			{children}
		</MainPanelContext.Provider>
	);
}
