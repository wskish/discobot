import * as React from "react";
import { ChatPanel } from "@/components/ide/chat-panel";
import { ConsolidatedDiffView } from "@/components/ide/consolidated-diff-view";
import { DiffContent } from "@/components/ide/diff-content";
import { FilePanel } from "@/components/ide/file-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import { ServiceView } from "@/components/ide/service-view";
import { SessionViewHeader } from "@/components/ide/session-view-header";
import { TerminalView } from "@/components/ide/terminal-view";
import type { FileNode, FileStatus } from "@/lib/api-types";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import { useMessages } from "@/lib/hooks/use-messages";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useSessionFiles } from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

const RIGHT_SIDEBAR_DEFAULT_WIDTH = 224;
const RIGHT_SIDEBAR_MIN_WIDTH = 160;
const RIGHT_SIDEBAR_MAX_WIDTH = 400;

/**
 * Create a minimal FileNode from a file path and optional status.
 * The diff view will fetch actual content via hooks.
 */
function createFileNodeFromPath(path: string, status?: FileStatus): FileNode {
	const name = path.split("/").pop() || path;
	return {
		id: path,
		name,
		type: "file",
		changed: status !== undefined,
		status,
	};
}

interface SessionViewProps {
	sessionId: string | null;
	isNew: boolean;
	onSessionCreated?: (
		sessionId: string,
		workspaceId: string,
		agentId: string,
	) => void;
}

export function SessionView({ isNew, onSessionCreated }: SessionViewProps) {
	// Manage right sidebar width state
	const [rightSidebarWidth, setRightSidebarWidth] = usePersistedState(
		STORAGE_KEYS.RIGHT_SIDEBAR_WIDTH,
		RIGHT_SIDEBAR_DEFAULT_WIDTH,
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

	const {
		selectedSessionId,
		activeView,
		setActiveView,
		activeFilePathFromView,
		terminalMounted,
		terminalRoot,
		terminalRef,
		setTerminalStatus,
		services,
		activeServiceId,
		mountedServices,
		rightSidebarOpen,
		refreshDiffData,
	} = useSessionViewContext();

	// Fetch diff entries for rendering file content
	const { diffEntries } = useSessionFiles(selectedSessionId, false);

	// For existing sessions, fetch messages to pass to ChatPanel
	const {
		messages: existingMessages,
		isLoading: messagesLoading,
		error: messagesError,
	} = useMessages(!isNew ? selectedSessionId : null);

	// Handle chat completion to refresh file data
	const handleChatComplete = React.useCallback(() => {
		refreshDiffData();
	}, [refreshDiffData]);

	// Show file panel when session is selected
	const showFilePanel = selectedSessionId !== null;

	return (
		<>
			<div className="flex flex-col overflow-hidden flex-1">
				<SessionViewHeader />
				<div
					className={cn(
						"flex-1 overflow-hidden relative",
						!selectedSessionId && "flex items-center justify-center",
					)}
				>
					{/* Chat panel - always render in same position */}
					{selectedSessionId && (
						<div
							className={cn(
								"absolute inset-0",
								activeView !== "chat" && "invisible pointer-events-none",
							)}
						>
							{!isNew && messagesError ? (
								<div className="flex flex-col h-full items-center justify-center">
									<div className="text-destructive text-sm">
										Failed to load messages: {messagesError.message}
									</div>
								</div>
							) : !isNew && messagesLoading ? (
								<div className="flex flex-col h-full items-center justify-center">
									<div className="text-sm text-muted-foreground">
										Loading messages...
									</div>
								</div>
							) : (
								<ChatPanel
									key={selectedSessionId}
									sessionId={selectedSessionId}
									initialMessages={!isNew ? existingMessages : undefined}
									onSessionCreated={onSessionCreated}
									onChatComplete={handleChatComplete}
									className="h-full"
								/>
							)}
						</div>
					)}
					{/* Terminal - lazy mounted, stays mounted once viewed */}
					{terminalMounted && (
						<div
							className={cn(
								"absolute inset-0",
								activeView !== "terminal" && "invisible pointer-events-none",
							)}
						>
							<TerminalView
								ref={terminalRef}
								sessionId={selectedSessionId}
								root={terminalRoot}
								className="h-full"
								onToggleChat={() => setActiveView("chat")}
								hideHeader
								onConnectionStatusChange={setTerminalStatus}
							/>
						</div>
					)}
					{/* Consolidated diff view - GitHub-style stacked diffs */}
					{selectedSessionId && (
						<div
							className={cn(
								"absolute inset-0",
								activeView !== "consolidated-diff" &&
									"invisible pointer-events-none",
							)}
						>
							<ConsolidatedDiffView />
						</div>
					)}
					{/* Service views - lazy mounted, stay mounted once viewed */}
					{selectedSessionId &&
						services
							.filter((s) => mountedServices.has(s.id))
							.map((service) => (
								<div
									key={service.id}
									className={cn(
										"absolute inset-0",
										activeServiceId !== service.id &&
											"invisible pointer-events-none",
									)}
								>
									<ServiceView
										sessionId={selectedSessionId}
										service={service}
										className="h-full"
									/>
								</div>
							))}
					{/* File diff content - rendered for any file: view */}
					{activeFilePathFromView && (
						<div
							className={cn(
								"absolute inset-0 flex flex-col",
								!activeFilePathFromView && "invisible pointer-events-none",
							)}
						>
							<DiffContent
								file={createFileNodeFromPath(
									activeFilePathFromView,
									diffEntries.find((e) => e.path === activeFilePathFromView)
										?.status,
								)}
							/>
						</div>
					)}
				</div>
			</div>

			{/* Right - File panel (only show when session is selected) */}
			{showFilePanel && rightSidebarOpen && (
				<div className="relative">
					<ResizeHandle
						orientation="vertical"
						onResize={handleRightSidebarResize}
					/>
					<FilePanel
						className="overflow-hidden"
						style={{ width: rightSidebarWidth }}
					/>
				</div>
			)}
		</>
	);
}
