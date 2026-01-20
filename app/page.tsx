"use client";

import * as React from "react";
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

const LEFT_SIDEBAR_DEFAULT_WIDTH = 256;
const LEFT_SIDEBAR_MIN_WIDTH = 180;
const LEFT_SIDEBAR_MAX_WIDTH = 480;
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 224;
const RIGHT_SIDEBAR_MIN_WIDTH = 160;
const RIGHT_SIDEBAR_MAX_WIDTH = 400;

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
		false,
	);
	const [leftSidebarWidth, setLeftSidebarWidth] = usePersistedState(
		STORAGE_KEYS.LEFT_SIDEBAR_WIDTH,
		LEFT_SIDEBAR_DEFAULT_WIDTH,
	);
	const [rightSidebarOpen, setRightSidebarOpen] = usePersistedState(
		STORAGE_KEYS.RIGHT_SIDEBAR_OPEN,
		true,
	);
	const [rightSidebarWidth, setRightSidebarWidth] = usePersistedState(
		STORAGE_KEYS.RIGHT_SIDEBAR_WIDTH,
		RIGHT_SIDEBAR_DEFAULT_WIDTH,
	);

	const handleLeftSidebarResize = React.useCallback(
		(delta: number) => {
			setLeftSidebarWidth((prev) =>
				Math.min(
					LEFT_SIDEBAR_MAX_WIDTH,
					Math.max(LEFT_SIDEBAR_MIN_WIDTH, prev + delta),
				),
			);
		},
		[setLeftSidebarWidth],
	);

	const handleRightSidebarResize = React.useCallback(
		(delta: number) => {
			// Delta is positive when moving right, but we want to grow when moving left
			setRightSidebarWidth((prev) =>
				Math.min(
					RIGHT_SIDEBAR_MAX_WIDTH,
					Math.max(RIGHT_SIDEBAR_MIN_WIDTH, prev - delta),
				),
			);
		},
		[setRightSidebarWidth],
	);

	// Track left sidebar state before maximize to restore it
	const leftSidebarBeforeMaximize = React.useRef<boolean | null>(null);

	const handleDiffMaximizeChange = React.useCallback(
		(isMaximized: boolean) => {
			if (isMaximized) {
				// Save left sidebar state and close it (right sidebar stays untouched)
				leftSidebarBeforeMaximize.current = leftSidebarOpen;
				setLeftSidebarOpen(false);
			} else {
				// Restore left sidebar state
				if (leftSidebarBeforeMaximize.current !== null) {
					setLeftSidebarOpen(leftSidebarBeforeMaximize.current);
					leftSidebarBeforeMaximize.current = null;
				}
			}
		},
		[leftSidebarOpen, setLeftSidebarOpen],
	);

	const session = useSessionContext();

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
				<LeftSidebar
					isOpen={leftSidebarOpen}
					width={leftSidebarWidth}
					onResize={handleLeftSidebarResize}
				/>
				<MainContent
					rightSidebarOpen={rightSidebarOpen}
					rightSidebarWidth={rightSidebarWidth}
					onToggleRightSidebar={() => setRightSidebarOpen(!rightSidebarOpen)}
					onRightSidebarResize={handleRightSidebarResize}
					onDiffMaximizeChange={handleDiffMaximizeChange}
				/>
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
