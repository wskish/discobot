"use client";

import * as React from "react";
import { ChatPanel } from "@/components/ide/chat-panel";
import { FilePanel } from "@/components/ide/file-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import type { FileNode } from "@/lib/api-types";
import { useSessionContext } from "@/lib/contexts/session-context";
import { usePanelLayout } from "@/lib/hooks/use-panel-layout";
import { BottomPanel } from "./bottom-panel";
import { DiffPanel } from "./diff-panel";

type BottomView = "chat" | "terminal";

/**
 * Create a minimal FileNode from a file path.
 * The diff view will fetch actual content via hooks.
 */
function createFileNodeFromPath(path: string): FileNode {
	const name = path.split("/").pop() || path;
	return {
		id: path, // Use path as ID for now
		name,
		type: "file",
		changed: true, // Mark as changed since we're showing it in diff view
	};
}

export function MainContent() {
	const { selectedSession, chatResetTrigger } = useSessionContext();

	const [bottomView, setBottomView] = React.useState<BottomView>("chat");
	const [openFiles, setOpenFiles] = React.useState<FileNode[]>([]);
	const [activeFilePath, setActiveFilePath] = React.useState<string | null>(
		null,
	);

	// Panel layout hook - now internal to MainContent
	const panelLayout = usePanelLayout();

	// Destructure stable handlers for use in effects
	const { handleCloseDiffPanel, resetPanels, showDiff } = panelLayout;

	// Reset files when session changes
	const prevSessionId = React.useRef<string | null>(null);
	React.useEffect(() => {
		if (selectedSession?.id !== prevSessionId.current) {
			setOpenFiles([]);
			setActiveFilePath(null);
			handleCloseDiffPanel();
			resetPanels();
			prevSessionId.current = selectedSession?.id ?? null;
		}
	}, [selectedSession?.id, handleCloseDiffPanel, resetPanels]);

	const handleFileSelect = React.useCallback(
		(path: string) => {
			// Create a FileNode from the path for the diff view
			const fileNode = createFileNodeFromPath(path);
			setOpenFiles((prev) => {
				if (!prev.find((f) => f.id === path)) {
					return [...prev, fileNode];
				}
				return prev;
			});
			setActiveFilePath(path);
			showDiff();
		},
		[showDiff],
	);

	const handleTabClose = React.useCallback(
		(fileId: string) => {
			setOpenFiles((prev) => {
				const newOpenFiles = prev.filter((f) => f.id !== fileId);

				if (activeFilePath === fileId) {
					if (newOpenFiles.length > 0) {
						setActiveFilePath(newOpenFiles[newOpenFiles.length - 1].id);
					} else {
						setActiveFilePath(null);
						handleCloseDiffPanel();
					}
				}

				return newOpenFiles;
			});
		},
		[activeFilePath, handleCloseDiffPanel],
	);

	const handleTabSelect = React.useCallback((file: FileNode) => {
		setActiveFilePath(file.id);
	}, []);

	const handleDiffClose = React.useCallback(() => {
		setOpenFiles([]);
		setActiveFilePath(null);
		handleCloseDiffPanel();
	}, [handleCloseDiffPanel]);

	// Computed
	const showCenteredChat = selectedSession === null;
	const showFilePanel = selectedSession !== null;

	if (showCenteredChat) {
		return (
			<main className="flex-1 flex items-center justify-center overflow-hidden">
				<ChatPanel key={chatResetTrigger} className="w-full h-full" />
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
					activeFileId={activeFilePath}
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
				/>
			</main>

			{/* Right - File panel (only show when session is selected) */}
			{showFilePanel && (
				<FilePanel
					sessionId={selectedSession?.id ?? null}
					onFileSelect={handleFileSelect}
					selectedFilePath={activeFilePath}
					className="w-56"
				/>
			)}
		</>
	);
}
