"use client";

import * as React from "react";
import { ChatPanel } from "@/components/ide/chat-panel";
import { FilePanel } from "@/components/ide/file-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import type {
	Agent,
	ChatMessage,
	FileNode,
	Session,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { usePanelLayout } from "@/lib/hooks/use-panel-layout";
import { BottomPanel } from "./bottom-panel";
import { DiffPanel } from "./diff-panel";

type BottomView = "chat" | "terminal";

interface MainContentProps {
	// Session state
	selectedSession: Session | null;

	// Centered chat props
	workspaces: Workspace[];
	agents: Agent[];
	agentTypes: SupportedAgentType[];
	preselectedWorkspaceId: string | null;
	workspaceSelectTrigger: number;
	selectedAgentId: string | null;
	onAddWorkspace: () => void;
	onAddAgent: () => void;
	onFirstMessage: (
		message: string,
		workspaceId: string,
		agentId: string,
	) => void;

	// Session chat props
	messages: ChatMessage[];
	sessionAgent: Agent | null;
	sessionWorkspace: Workspace | null;

	// Session actions
	onCloseSession?: (saveChanges: boolean) => void;
}

export function MainContent({
	selectedSession,
	workspaces,
	agents,
	agentTypes,
	preselectedWorkspaceId,
	workspaceSelectTrigger,
	selectedAgentId,
	onAddWorkspace,
	onAddAgent,
	onFirstMessage,
	messages,
	sessionAgent,
	sessionWorkspace,
	onCloseSession,
}: MainContentProps) {
	const [bottomView, setBottomView] = React.useState<BottomView>("chat");
	const [openFiles, setOpenFiles] = React.useState<FileNode[]>([]);
	const [activeFileId, setActiveFileId] = React.useState<string | null>(null);

	// Panel layout hook - now internal to MainContent
	const panelLayout = usePanelLayout();

	// Destructure stable handlers for use in effects
	const { handleCloseDiffPanel, resetPanels, showDiff } = panelLayout;

	// Reset files when session changes
	const prevSessionId = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (selectedSession?.id !== prevSessionId.current) {
			setOpenFiles([]);
			setActiveFileId(null);
			handleCloseDiffPanel();
			resetPanels();
			prevSessionId.current = selectedSession?.id ?? null;
		}
	}, [selectedSession?.id, handleCloseDiffPanel, resetPanels]);

	const handleFileSelect = React.useCallback(
		(file: FileNode) => {
			if (file.type === "file") {
				setOpenFiles((prev) => {
					if (!prev.find((f) => f.id === file.id)) {
						return [...prev, file];
					}
					return prev;
				});
				setActiveFileId(file.id);
				showDiff();
			}
		},
		[showDiff],
	);

	const handleTabClose = React.useCallback(
		(fileId: string) => {
			setOpenFiles((prev) => {
				const newOpenFiles = prev.filter((f) => f.id !== fileId);

				if (activeFileId === fileId) {
					if (newOpenFiles.length > 0) {
						setActiveFileId(newOpenFiles[newOpenFiles.length - 1].id);
					} else {
						setActiveFileId(null);
						handleCloseDiffPanel();
					}
				}

				return newOpenFiles;
			});
		},
		[activeFileId, handleCloseDiffPanel],
	);

	const handleTabSelect = React.useCallback((file: FileNode) => {
		setActiveFileId(file.id);
	}, []);

	const handleDiffClose = React.useCallback(() => {
		setOpenFiles([]);
		setActiveFileId(null);
		handleCloseDiffPanel();
	}, [handleCloseDiffPanel]);

	// Computed
	const showCenteredChat = selectedSession === null;
	const showFilePanel = selectedSession !== null;

	if (showCenteredChat) {
		return (
			<main className="flex-1 flex items-center justify-center overflow-hidden">
				<ChatPanel
					initialMessages={[]}
					onFirstMessage={onFirstMessage}
					workspaces={workspaces}
					selectedWorkspaceId={preselectedWorkspaceId}
					onAddWorkspace={onAddWorkspace}
					className="w-full h-full"
					workspaceSelectTrigger={workspaceSelectTrigger}
					agents={agents}
					selectedAgentId={selectedAgentId}
					onAddAgent={onAddAgent}
					agentTypes={agentTypes}
				/>
			</main>
		);
	}

	return (
		<>
			<main
				ref={panelLayout.mainRef}
				className="flex-1 flex flex-col overflow-hidden"
			>
				{/* Top: Diff panel with tabs (when files are open) */}
				<DiffPanel
					isVisible={panelLayout.showDiffPanel}
					panelState={panelLayout.diffPanelState}
					style={panelLayout.getDiffPanelStyle()}
					openFiles={openFiles}
					activeFileId={activeFileId}
					onTabSelect={handleTabSelect}
					onTabClose={handleTabClose}
					onMinimize={panelLayout.handleDiffMinimize}
					onMaximize={panelLayout.handleDiffMaximize}
					onClose={handleDiffClose}
				/>

				{panelLayout.showResizeHandle && (
					<ResizeHandle onResize={panelLayout.handleResize} />
				)}

				<BottomPanel
					panelState={panelLayout.bottomPanelState}
					style={panelLayout.getBottomPanelStyle()}
					showPanelControls={panelLayout.showDiffPanel}
					view={bottomView}
					onViewChange={setBottomView}
					onMinimize={panelLayout.handleBottomMinimize}
					onMaximize={panelLayout.handleBottomMaximize}
					messages={messages}
					session={selectedSession}
					sessionAgent={sessionAgent}
					sessionWorkspace={sessionWorkspace}
					agentTypes={agentTypes}
					agents={agents}
				/>
			</main>

			{/* Right - File panel (only show when session is selected) */}
			{showFilePanel && (
				<FilePanel
					session={selectedSession}
					onFileSelect={handleFileSelect}
					selectedFileId={activeFileId}
					className="w-56"
					onCloseSession={onCloseSession}
				/>
			)}
		</>
	);
}
