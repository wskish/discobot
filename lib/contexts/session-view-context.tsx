import * as React from "react";
import { useSWRConfig } from "swr";
import type {
	ConnectionStatus,
	TerminalViewHandle,
} from "@/components/ide/terminal-view";
import { api } from "@/lib/api-client";
import type {
	ActiveView,
	FileNode,
	FileStatus,
	Session,
} from "@/lib/api-types";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useServices } from "@/lib/hooks/use-services";
import { useSessionFiles } from "@/lib/hooks/use-session-files";
import { useSession } from "@/lib/hooks/use-sessions";

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

export interface SessionViewContextValue {
	// Session state
	selectedSessionId: string | null;
	selectedSession: Session | null | undefined;
	isSessionLoading: boolean;

	// Active view within session (chat, terminal, file, service)
	activeView: ActiveView;
	setActiveView: (view: ActiveView) => void;

	// File tab state
	openFilePaths: string[];
	activeFilePath: string | null;
	openFiles: FileNode[];
	activeFilePathFromView: string | null;
	handleFileSelect: (path: string) => void;
	handleTabClose: (fileId: string) => void;

	// Terminal state
	terminalMounted: boolean;
	terminalRoot: boolean;
	terminalStatus: ConnectionStatus;
	terminalRef: React.RefObject<TerminalViewHandle | null>;
	setTerminalRoot: (root: boolean) => void;
	setTerminalStatus: (status: ConnectionStatus) => void;

	// Services state
	services: ReturnType<typeof useServices>["services"];
	activeServiceId: string | null;
	mountedServices: Set<string>;
	startService: (serviceId: string) => void;
	stopService: (serviceId: string) => void;

	// Commit state
	isCommitting: boolean;
	handleCommit: () => Promise<void>;
	/** Register the chat's resumeStream function for use after commit starts */
	registerChatResumeStream: (fn: (() => Promise<void>) | null) => void;

	// Right sidebar controls (managed internally)
	rightSidebarOpen: boolean;
	changedFilesCount: number;
	onToggleRightSidebar: () => void;

	// Data refresh
	refreshDiffData: () => void;
}

const SessionViewContext = React.createContext<SessionViewContextValue | null>(
	null,
);

export function useSessionViewContext() {
	const context = React.useContext(SessionViewContext);
	if (!context) {
		throw new Error(
			"useSessionViewContext must be used within a SessionViewProvider",
		);
	}
	return context;
}

interface SessionViewProviderProps {
	children: React.ReactNode;
	sessionId: string | null;
}

export function SessionViewProvider({
	children,
	sessionId,
}: SessionViewProviderProps) {
	const selectedSessionId = sessionId;

	// Get SWR mutate for refreshing data
	const { mutate } = useSWRConfig();

	// Fetch session data
	const { session: selectedSession, isLoading: isSessionLoading } =
		useSession(selectedSessionId);

	// Right sidebar state
	const [rightSidebarOpen, setRightSidebarOpen] = usePersistedState(
		STORAGE_KEYS.RIGHT_SIDEBAR_OPEN,
		false,
	);

	// Fetch session files for changed files count
	const { diffStats, changedFiles } = useSessionFiles(selectedSessionId, false);
	const changedFilesCount = diffStats?.filesChanged ?? changedFiles.length;

	// Active view state (persisted per session in sessionStorage)
	const activeViewKey = selectedSessionId
		? `${STORAGE_KEYS.ACTIVE_VIEW}:${selectedSessionId}`
		: STORAGE_KEYS.ACTIVE_VIEW;

	const [activeView, setActiveView] = usePersistedState<ActiveView>(
		activeViewKey,
		"chat",
		"session",
	);

	// Reset activeView to chat when session becomes null
	React.useEffect(() => {
		if (!selectedSessionId) {
			setActiveView("chat");
		}
	}, [selectedSessionId, setActiveView]);

	// File tab state (persisted per session)
	const openFilePathsKey = selectedSessionId
		? `${STORAGE_KEYS.OPEN_FILE_PATHS}:${selectedSessionId}`
		: STORAGE_KEYS.OPEN_FILE_PATHS;
	const activeFilePathKey = selectedSessionId
		? `${STORAGE_KEYS.ACTIVE_FILE_PATH}:${selectedSessionId}`
		: STORAGE_KEYS.ACTIVE_FILE_PATH;

	const [openFilePaths, setOpenFilePaths] = usePersistedState<string[]>(
		openFilePathsKey,
		[],
		"session",
	);
	const [activeFilePath, setActiveFilePath] = usePersistedState<string | null>(
		activeFilePathKey,
		null,
		"session",
	);

	// Fetch file statuses for badges
	const { diffEntries } = useSessionFiles(selectedSessionId, false);

	// Build FileNode objects for tabs
	const openFiles = React.useMemo(() => {
		const statusMap = new Map(
			diffEntries.map((e) => [e.path, e.status] as const),
		);
		return openFilePaths.map((path) =>
			createFileNodeFromPath(path, statusMap.get(path)),
		);
	}, [openFilePaths, diffEntries]);

	// Handle file selection
	const handleFileSelect = React.useCallback(
		(path: string) => {
			if (!openFilePaths.includes(path)) {
				setOpenFilePaths((prev) => [...prev, path]);
			}
			setActiveFilePath(path);
			setActiveView(`file:${path}`);
		},
		[openFilePaths, setOpenFilePaths, setActiveFilePath, setActiveView],
	);

	// Handle tab close
	const handleTabClose = React.useCallback(
		(fileId: string) => {
			setOpenFilePaths((prev) => {
				const newPaths = prev.filter((p) => p !== fileId);
				if (activeFilePath === fileId) {
					if (newPaths.length > 0) {
						const nextFile = newPaths[newPaths.length - 1];
						setActiveFilePath(nextFile);
						setActiveView(`file:${nextFile}`);
					} else {
						setActiveFilePath(null);
						setActiveView("chat");
					}
				}
				return newPaths;
			});
		},
		[activeFilePath, setOpenFilePaths, setActiveFilePath, setActiveView],
	);

	// Extract active file path from activeView
	const activeFilePathFromView = activeView.startsWith("file:")
		? activeView.slice(5)
		: null;

	// Sync activeFilePath with activeView
	React.useEffect(() => {
		if (activeFilePathFromView && activeFilePathFromView !== activeFilePath) {
			setActiveFilePath(activeFilePathFromView);
		}
	}, [activeFilePathFromView, activeFilePath, setActiveFilePath]);

	// Terminal state
	const [terminalMounted, setTerminalMounted] = React.useState(false);
	const [terminalRoot, setTerminalRoot] = React.useState(false);
	const [terminalStatus, setTerminalStatus] =
		React.useState<ConnectionStatus>("disconnected");
	const terminalRef = React.useRef<TerminalViewHandle>(null);

	// Mount terminal when first viewed
	React.useEffect(() => {
		if (activeView === "terminal" && !terminalMounted) {
			setTerminalMounted(true);
		}
	}, [activeView, terminalMounted]);

	// Services state
	const { services, startService, stopService } =
		useServices(selectedSessionId);

	const activeServiceId = activeView.startsWith("service:")
		? activeView.slice(8)
		: null;

	const [mountedServices, setMountedServices] = React.useState<Set<string>>(
		new Set(),
	);

	// Mount service output when first viewed
	React.useEffect(() => {
		if (activeServiceId && !mountedServices.has(activeServiceId)) {
			setMountedServices((prev) => new Set(prev).add(activeServiceId));
		}
	}, [activeServiceId, mountedServices]);

	// Commit state
	const [isCommitting, setIsCommitting] = React.useState(false);
	const chatResumeStreamRef = React.useRef<(() => Promise<void>) | null>(null);

	const registerChatResumeStream = React.useCallback(
		(fn: (() => Promise<void>) | null) => {
			chatResumeStreamRef.current = fn;
		},
		[],
	);

	const handleCommit = React.useCallback(async () => {
		if (!selectedSessionId || isCommitting) return;

		try {
			setIsCommitting(true);
			// Start the commit job on the server
			await api.commitSession(selectedSessionId);

			// Give the server a moment to start the stream, then resume it in the chat
			// The resumeStream will connect to GET /chat/{sessionId}/stream
			setTimeout(() => {
				chatResumeStreamRef.current?.();
			}, 100);
		} catch (error) {
			console.error("Failed to start commit:", error);
		} finally {
			setIsCommitting(false);
		}
	}, [selectedSessionId, isCommitting]);

	const onToggleRightSidebar = React.useCallback(() => {
		setRightSidebarOpen(!rightSidebarOpen);
	}, [rightSidebarOpen, setRightSidebarOpen]);

	// Refresh diff data (called after chat completion)
	const refreshDiffData = React.useCallback(() => {
		if (selectedSessionId) {
			// Invalidate all caches starting with session-diff-${sessionId}- to refresh both
			// the file list and all individual file diffs
			mutate(
				(key) =>
					typeof key === "string" &&
					key.startsWith(`session-diff-${selectedSessionId}-`),
				undefined,
				{ revalidate: true },
			);
		}
	}, [selectedSessionId, mutate]);

	const value = React.useMemo<SessionViewContextValue>(
		() => ({
			selectedSessionId,
			selectedSession,
			isSessionLoading,
			activeView,
			setActiveView,
			openFilePaths,
			activeFilePath,
			openFiles,
			activeFilePathFromView,
			handleFileSelect,
			handleTabClose,
			terminalMounted,
			terminalRoot,
			terminalStatus,
			terminalRef,
			setTerminalRoot,
			setTerminalStatus,
			services,
			activeServiceId,
			mountedServices,
			startService,
			stopService,
			isCommitting,
			handleCommit,
			registerChatResumeStream,
			rightSidebarOpen,
			changedFilesCount,
			onToggleRightSidebar,
			refreshDiffData,
		}),
		[
			selectedSessionId,
			selectedSession,
			isSessionLoading,
			activeView,
			setActiveView,
			openFilePaths,
			activeFilePath,
			openFiles,
			activeFilePathFromView,
			handleFileSelect,
			handleTabClose,
			terminalMounted,
			terminalRoot,
			terminalStatus,
			services,
			activeServiceId,
			mountedServices,
			startService,
			stopService,
			isCommitting,
			handleCommit,
			registerChatResumeStream,
			rightSidebarOpen,
			changedFilesCount,
			onToggleRightSidebar,
			refreshDiffData,
		],
	);

	return (
		<SessionViewContext.Provider value={value}>
			{children}
		</SessionViewContext.Provider>
	);
}
