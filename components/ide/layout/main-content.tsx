"use client";

import * as React from "react";
import { FilePanel } from "@/components/ide/file-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import type { BottomView, FileNode, FileStatus } from "@/lib/api-types";
import { useSessionContext } from "@/lib/contexts/session-context";
import { usePanelLayout } from "@/lib/hooks/use-panel-layout";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { usePrevious } from "@/lib/hooks/use-previous";
import { useSessionFiles } from "@/lib/hooks/use-session-files";
import { BottomPanel } from "./bottom-panel";
import { DiffPanel } from "./diff-panel";

interface MainContentProps {
	rightSidebarOpen?: boolean;
	rightSidebarWidth?: number;
	onToggleRightSidebar?: () => void;
	onRightSidebarResize?: (delta: number) => void;
	onDiffMaximizeChange?: (isMaximized: boolean) => void;
}

/**
 * Create a minimal FileNode from a file path and optional status.
 * The diff view will fetch actual content via hooks.
 */
function createFileNodeFromPath(path: string, status?: FileStatus): FileNode {
	const name = path.split("/").pop() || path;
	return {
		id: path, // Use path as ID for now
		name,
		type: "file",
		changed: status !== undefined, // Only mark as changed if file has a diff status
		status,
	};
}

export function MainContent({
	rightSidebarOpen = true,
	rightSidebarWidth = 224,
	onToggleRightSidebar,
	onRightSidebarResize,
	onDiffMaximizeChange,
}: MainContentProps) {
	const { selectedSession } = useSessionContext();

	const [bottomView, setBottomView] = usePersistedState<BottomView>(
		STORAGE_KEYS.BOTTOM_VIEW,
		"chat",
	);

	// Persist open file paths and active file in sessionStorage (per-tab)
	const [openFilePaths, setOpenFilePaths] = usePersistedState<string[]>(
		STORAGE_KEYS.OPEN_FILE_PATHS,
		[],
		"session",
	);
	const [activeFilePath, setActiveFilePath] = usePersistedState<string | null>(
		STORAGE_KEYS.ACTIVE_FILE_PATH,
		null,
		"session",
	);

	// Panel layout hook - now internal to MainContent
	const panelLayout = usePanelLayout();

	// Get changed files count for the bottom panel toggle
	const { diffStats, changedFiles, diffEntries } = useSessionFiles(
		selectedSession?.id ?? null,
		false, // Only need changed files, not full tree
	);
	const changedCount = diffStats?.filesChanged ?? changedFiles.length;

	// Build a map of file path to status for quick lookup
	const statusMap = React.useMemo(() => {
		const map = new Map<string, FileStatus>();
		for (const entry of diffEntries) {
			map.set(entry.path, entry.status);
		}
		return map;
	}, [diffEntries]);

	// Derive FileNode objects from persisted paths
	const openFiles = React.useMemo(() => {
		return openFilePaths.map((path) =>
			createFileNodeFromPath(path, statusMap.get(path)),
		);
	}, [openFilePaths, statusMap]);

	// Track previous maximize state to detect changes
	const isMaximized = panelLayout.diffPanelState === "maximized";
	const prevDiffMaximized = usePrevious(isMaximized);

	// Notify parent when diff maximize state changes
	React.useEffect(() => {
		if (prevDiffMaximized !== undefined && isMaximized !== prevDiffMaximized) {
			onDiffMaximizeChange?.(isMaximized);
		}
	}, [isMaximized, prevDiffMaximized, onDiffMaximizeChange]);

	// Destructure stable handlers for use in effects
	const { handleCloseDiffPanel, resetPanels, showDiff } = panelLayout;

	// Show diff panel on mount if there are persisted open files
	const hasInitializedDiffPanel = React.useRef(false);
	React.useEffect(() => {
		if (!hasInitializedDiffPanel.current && openFilePaths.length > 0) {
			hasInitializedDiffPanel.current = true;
			showDiff();
		}
	}, [openFilePaths.length, showDiff]);

	// Reset files when session changes
	const currentSessionId = selectedSession?.id ?? null;
	const prevSessionId = usePrevious(currentSessionId);

	React.useEffect(() => {
		if (prevSessionId !== undefined && currentSessionId !== prevSessionId) {
			setOpenFilePaths([]);
			setActiveFilePath(null);
			handleCloseDiffPanel();
			resetPanels();
		}
	}, [
		currentSessionId,
		prevSessionId,
		handleCloseDiffPanel,
		resetPanels,
		setOpenFilePaths,
		setActiveFilePath,
	]);

	const handleFileSelect = React.useCallback(
		(path: string) => {
			// Add path to open files if not already open
			setOpenFilePaths((prev) => {
				if (!prev.includes(path)) {
					return [...prev, path];
				}
				return prev;
			});
			setActiveFilePath(path);
			showDiff();
		},
		[showDiff, setOpenFilePaths, setActiveFilePath],
	);

	const handleTabClose = React.useCallback(
		(fileId: string) => {
			setOpenFilePaths((prev) => {
				const newOpenPaths = prev.filter((path) => path !== fileId);

				if (activeFilePath === fileId) {
					if (newOpenPaths.length > 0) {
						setActiveFilePath(newOpenPaths[newOpenPaths.length - 1]);
					} else {
						setActiveFilePath(null);
						handleCloseDiffPanel();
					}
				}

				return newOpenPaths;
			});
		},
		[activeFilePath, handleCloseDiffPanel, setOpenFilePaths, setActiveFilePath],
	);

	const handleTabSelect = React.useCallback(
		(file: FileNode) => {
			setActiveFilePath(file.id);
		},
		[setActiveFilePath],
	);

	const handleDiffClose = React.useCallback(() => {
		setOpenFilePaths([]);
		setActiveFilePath(null);
		handleCloseDiffPanel();
	}, [handleCloseDiffPanel, setOpenFilePaths, setActiveFilePath]);

	// Computed
	const showFilePanel = selectedSession !== null;

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
					rightSidebarOpen={rightSidebarOpen}
					onToggleRightSidebar={onToggleRightSidebar}
					changedFilesCount={changedCount}
				/>
			</main>

			{/* Right - File panel (only show when session is selected) */}
			{showFilePanel && rightSidebarOpen && (
				<>
					<ResizeHandle
						orientation="vertical"
						onResize={onRightSidebarResize ?? (() => {})}
					/>
					<FilePanel
						sessionId={selectedSession?.id ?? null}
						onFileSelect={handleFileSelect}
						selectedFilePath={activeFilePath}
						className="overflow-hidden"
						style={{ width: rightSidebarWidth }}
					/>
				</>
			)}
		</>
	);
}
