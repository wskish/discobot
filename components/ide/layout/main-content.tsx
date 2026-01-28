import * as React from "react";
import { DiffContent } from "@/components/ide/diff-content";
import { FilePanel } from "@/components/ide/file-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import { SessionListTable } from "@/components/ide/session-list-table";
import { getWorkspaceDisplayPath } from "@/components/ide/workspace-path";
import type { BottomView, FileNode, FileStatus } from "@/lib/api-types";
import { useMainPanelContext } from "@/lib/contexts/main-panel-context";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useSessionFiles } from "@/lib/hooks/use-session-files";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { BottomPanel } from "./bottom-panel";

interface MainContentProps {
	rightSidebarOpen?: boolean;
	rightSidebarWidth?: number;
	onToggleRightSidebar?: () => void;
	onRightSidebarResize?: (delta: number) => void;
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
}: MainContentProps) {
	const { view, selectedSession, showSession, showNewSession } =
		useMainPanelContext();
	const { workspaces } = useWorkspaces();

	const [bottomView, setBottomView] = React.useState<BottomView>("chat");

	// Helper to update view when file is selected
	const setBottomViewToFile = React.useCallback((filePath: string) => {
		setBottomView(`file:${filePath}`);
	}, []);

	// Get current session ID for keying storage
	const currentSessionId = selectedSession?.id ?? null;

	// Persist open file paths and active file in sessionStorage (per-tab, per-session)
	// Key by session ID to prevent file list conflicts when switching sessions
	const sessionStorageKey = currentSessionId
		? `${STORAGE_KEYS.OPEN_FILE_PATHS}:${currentSessionId}`
		: STORAGE_KEYS.OPEN_FILE_PATHS;
	const activeFileStorageKey = currentSessionId
		? `${STORAGE_KEYS.ACTIVE_FILE_PATH}:${currentSessionId}`
		: STORAGE_KEYS.ACTIVE_FILE_PATH;

	const [openFilePaths, setOpenFilePaths] = usePersistedState<string[]>(
		sessionStorageKey,
		[],
		"session",
	);
	const [activeFilePath, setActiveFilePath] = usePersistedState<string | null>(
		activeFileStorageKey,
		null,
		"session",
	);

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
			setBottomViewToFile(path);
		},
		[setOpenFilePaths, setActiveFilePath, setBottomViewToFile],
	);

	const handleTabClose = React.useCallback(
		(fileId: string) => {
			setOpenFilePaths((prev) => {
				const newOpenPaths = prev.filter((path) => path !== fileId);

				if (activeFilePath === fileId) {
					if (newOpenPaths.length > 0) {
						const nextFile = newOpenPaths[newOpenPaths.length - 1];
						setActiveFilePath(nextFile);
						setBottomViewToFile(nextFile);
					} else {
						setActiveFilePath(null);
						setBottomView("chat");
					}
				}

				return newOpenPaths;
			});
		},
		[activeFilePath, setOpenFilePaths, setActiveFilePath, setBottomViewToFile],
	);

	// Extract active file path from bottomView
	const activeFilePathFromView = bottomView.startsWith("file:")
		? bottomView.slice(5)
		: null;

	// Sync activeFilePath with the view when a file is shown
	React.useEffect(() => {
		if (activeFilePathFromView && activeFilePathFromView !== activeFilePath) {
			setActiveFilePath(activeFilePathFromView);
		}
	}, [activeFilePathFromView, activeFilePath, setActiveFilePath]);

	// Render diff content for the active file from the view
	const diffContent = React.useMemo(() => {
		if (!activeFilePathFromView) return null;
		const activeFile = openFiles.find((f) => f.id === activeFilePathFromView);
		if (!activeFile) return null;

		return <DiffContent file={activeFile} />;
	}, [activeFilePathFromView, openFiles]);

	// Computed
	const showFilePanel = selectedSession !== null;

	// Find selected workspace for workspace-sessions view
	const selectedWorkspace =
		view.type === "workspace-sessions"
			? workspaces.find((w) => w.id === view.workspaceId)
			: null;

	const [showClosedSessions] = usePersistedState(
		STORAGE_KEYS.SHOW_CLOSED_SESSIONS,
		false,
	);

	return (
		<>
			<main className="flex-1 flex flex-col overflow-hidden">
				{view.type === "workspace-sessions" && selectedWorkspace ? (
					<SessionListTable
						workspaceId={selectedWorkspace.id}
						workspaceName={
							selectedWorkspace.displayName ||
							getWorkspaceDisplayPath(
								selectedWorkspace.path,
								selectedWorkspace.sourceType,
							)
						}
						onSessionSelect={(session) => showSession(session.id)}
						onClose={() => showNewSession()}
						showClosedSessions={showClosedSessions}
					/>
				) : (
					<BottomPanel
						view={bottomView}
						onViewChange={setBottomView}
						rightSidebarOpen={rightSidebarOpen}
						onToggleRightSidebar={onToggleRightSidebar}
						changedFilesCount={changedCount}
						openFiles={openFiles}
						onTabClose={handleTabClose}
						diffContent={diffContent}
					/>
				)}
			</main>

			{/* Right - File panel (only show when session is selected) */}
			{showFilePanel && rightSidebarOpen && (
				<div className="relative">
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
				</div>
			)}
		</>
	);
}
