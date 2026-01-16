"use client";

import { DialogLayer } from "@/components/ide/dialog-layer";
import { Header, LeftSidebar, MainContent } from "@/components/ide/layout";
import {
	DialogProvider,
	SessionProvider,
	useSessionContext,
} from "@/lib/contexts";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useProjectEvents } from "@/lib/hooks/use-project-events";

function LoadingScreen() {
	return (
		<div className="h-screen flex items-center justify-center bg-background">
			<div className="text-muted-foreground">Loading...</div>
		</div>
	);
}

function IDEContent() {
	const [leftSidebarOpen, setLeftSidebarOpen] = usePersistedState(
		STORAGE_KEYS.LEFT_SIDEBAR_OPEN,
		true,
	);

	const session = useSessionContext();

	// Subscribe to SSE events for real-time session status updates
	useProjectEvents({
		onSessionUpdated: (data) => {
			console.log("Session updated:", data.sessionId, "->", data.status);
		},
	});

	// Loading state
	if (session.workspacesLoading || session.agentsLoading) {
		return <LoadingScreen />;
	}

	return (
		<div className="h-screen flex flex-col bg-background">
			<Header
				leftSidebarOpen={leftSidebarOpen}
				onToggleSidebar={() => setLeftSidebarOpen(!leftSidebarOpen)}
				onNewSession={session.handleNewSession}
			/>

			<div className="flex-1 flex overflow-hidden">
				<LeftSidebar isOpen={leftSidebarOpen} />
				<MainContent />
			</div>

			<DialogLayer />
		</div>
	);
}

export default function IDEChatPage() {
	return (
		<SessionProvider>
			<DialogProvider>
				<IDEContent />
			</DialogProvider>
		</SessionProvider>
	);
}
