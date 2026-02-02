import * as React from "react";
import { SessionListTable } from "@/components/ide/session-list-table";
import { SessionView } from "@/components/ide/session-view";
import { useMainContentContext } from "@/lib/contexts/main-content-context";
import { SessionViewProvider } from "@/lib/contexts/session-view-context";

export function MainContent() {
	const {
		view,
		getSessionIdForView,
		getSelectedWorkspaceId,
		isNewSession,
		sessionCreated,
	} = useMainContentContext();

	// Get session ID for rendering SessionView (includes temp ID for new sessions)
	const sessionIdForView = getSessionIdForView();
	const isNew = isNewSession();
	const initialWorkspaceId = getSelectedWorkspaceId();

	return (
		<main className="flex-1 flex overflow-hidden">
			{view.type === "workspace-sessions" ? (
				<SessionListTable />
			) : (
				<SessionViewProvider
					key={sessionIdForView || "no-session"}
					sessionId={sessionIdForView}
				>
					<SessionView
						sessionId={sessionIdForView}
						isNew={isNew}
						initialWorkspaceId={initialWorkspaceId}
						onSessionCreated={sessionCreated}
					/>
				</SessionViewProvider>
			)}
		</main>
	);
}
