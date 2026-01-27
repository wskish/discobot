"use client";

import {
	ChevronDown,
	ChevronRight,
	Circle,
	Eye,
	EyeOff,
	Loader2,
	MoreHorizontal,
	Plus,
} from "lucide-react";
import * as React from "react";
import { getSessionDisplayName } from "@/components/ide/session-name";
import {
	parseWorkspacePath,
	WorkspaceIcon,
} from "@/components/ide/workspace-path";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	CommitStatus,
	SessionStatus,
	WorkspaceStatus as WorkspaceStatusConstants,
} from "@/lib/api-constants";
import type { Session, Workspace, WorkspaceStatus } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useSessionContext } from "@/lib/contexts/session-context";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import {
	useDeleteSession,
	useSession,
	useSessions,
} from "@/lib/hooks/use-sessions";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { getSessionStatusIndicator } from "@/lib/session-utils";
import { cn } from "@/lib/utils";

interface SidebarTreeProps {
	className?: string;
}

const STORAGE_KEY = "octobot:sidebar-expanded-workspaces";

function loadExpandedIds(): Set<string> {
	if (typeof window === "undefined") return new Set();
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return new Set(parsed);
			}
		}
	} catch {
		// Ignore parse errors
	}
	return new Set();
}

function saveExpandedIds(ids: Set<string>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		// Ignore storage errors
	}
}

export function SidebarTree({ className }: SidebarTreeProps) {
	const { workspaces } = useWorkspaces();
	const {
		selectedSessionId,
		handleSessionSelect,
		handleAddSession,
		handleNewSession,
	} = useSessionContext();
	const { workspaceDialog, deleteWorkspaceDialog } = useDialogContext();

	const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
	const [showClosedSessions, setShowClosedSessions] = usePersistedState(
		STORAGE_KEYS.SHOW_CLOSED_SESSIONS,
		false,
	);

	// Load expanded state from localStorage on mount
	React.useEffect(() => {
		setExpandedIds(loadExpandedIds());
	}, []);

	const toggleExpand = (id: string) => {
		const next = new Set(expandedIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		setExpandedIds(next);
		saveExpandedIds(next);
	};

	return (
		<div className={cn("flex flex-col overflow-hidden", className)}>
			<div className="px-3 py-2 border-b border-sidebar-border flex items-center justify-between">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Workspaces
				</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						onClick={() => setShowClosedSessions(!showClosedSessions)}
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
						title={
							showClosedSessions ? "Hide done sessions" : "Show done sessions"
						}
					>
						{showClosedSessions ? (
							<Eye className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</button>
					<button
						type="button"
						onClick={() => workspaceDialog.open()}
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
						title="Add workspace"
					>
						<Plus className="h-3.5 w-3.5 text-muted-foreground" />
					</button>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto py-1">
				{workspaces.map((workspace) => (
					<WorkspaceNode
						key={workspace.id}
						workspace={workspace}
						isExpanded={expandedIds.has(workspace.id)}
						toggleExpand={toggleExpand}
						onSessionSelect={handleSessionSelect}
						selectedSessionId={selectedSessionId}
						onAddSession={handleAddSession}
						onDeleteWorkspace={deleteWorkspaceDialog.open}
						onClearSelection={handleNewSession}
						showClosedSessions={showClosedSessions}
					/>
				))}
			</div>
		</div>
	);
}

const WorkspaceNode = React.memo(function WorkspaceNode({
	workspace,
	isExpanded,
	toggleExpand,
	onSessionSelect,
	selectedSessionId,
	onAddSession,
	onDeleteWorkspace,
	onClearSelection,
	showClosedSessions,
}: {
	workspace: Workspace;
	isExpanded: boolean;
	toggleExpand: (id: string) => void;
	onSessionSelect: (session: { id: string }) => void;
	selectedSessionId: string | null;
	onAddSession: (workspaceId: string) => void;
	onDeleteWorkspace: (workspace: Workspace) => void;
	onClearSelection: () => void;
	showClosedSessions: boolean;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [isRenaming, setIsRenaming] = React.useState(false);
	const [editedName, setEditedName] = React.useState("");
	const { updateWorkspace } = useWorkspaces();
	const inputRef = React.useRef<HTMLInputElement>(null);

	const { displayPath, fullPath, workspaceType, wasShortened } =
		parseWorkspacePath(workspace.path, workspace.sourceType);

	// Fetch sessions when workspace is expanded
	// Server filters out closed sessions unless includeClosed is true
	const { sessions, isLoading: sessionsLoading } = useSessions(
		isExpanded ? workspace.id : null,
		{ includeClosed: showClosedSessions },
	);

	// Focus input when entering rename mode
	React.useEffect(() => {
		if (isRenaming && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isRenaming]);

	const startRename = () => {
		setEditedName(workspace.displayName || "");
		setIsRenaming(true);
		setMenuOpen(false);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setEditedName("");
	};

	const saveRename = async () => {
		const trimmedName = editedName.trim();
		// If empty or unchanged, just cancel
		if (trimmedName === (workspace.displayName || "")) {
			cancelRename();
			return;
		}

		try {
			// If empty, pass null to clear the display name and revert to path
			await updateWorkspace(workspace.id, {
				displayName: trimmedName === "" ? null : trimmedName,
			});
			setIsRenaming(false);
		} catch (error) {
			console.error("Failed to rename workspace:", error);
			// Keep in rename mode on error
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	};

	// Determine what to display: displayName or parsed path
	const displayName = workspace.displayName || displayPath;

	return (
		<div>
			{/* biome-ignore lint/a11y/useSemanticElements: Complex interactive pattern with nested action button */}
			<div
				className={cn(
					"group flex items-center px-2 py-1 hover:bg-sidebar-accent transition-colors cursor-pointer",
				)}
				onClick={() => !isRenaming && toggleExpand(workspace.id)}
				onKeyDown={(e) =>
					!isRenaming && e.key === "Enter" && toggleExpand(workspace.id)
				}
				role="button"
				tabIndex={0}
			>
				<div
					className="flex items-center gap-1.5 min-w-0 flex-1"
					title={
						isRenaming
							? undefined
							: workspace.displayName
								? `${workspace.displayName} (${fullPath})`
								: wasShortened
									? fullPath
									: undefined
					}
				>
					{isExpanded ? (
						<ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					)}
					{getWorkspaceStatusIndicator(workspace.status) ?? (
						<WorkspaceIcon
							workspaceType={workspaceType}
							className="h-4 w-4 shrink-0"
						/>
					)}
					{isRenaming ? (
						<input
							ref={inputRef}
							type="text"
							value={editedName}
							onChange={(e) => setEditedName(e.target.value)}
							onKeyDown={handleKeyDown}
							onBlur={saveRename}
							onClick={(e) => e.stopPropagation()}
							className="flex-1 min-w-0 px-1 py-0.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
							placeholder={displayPath}
						/>
					) : (
						<span className="font-mono truncate text-sm">{displayName}</span>
					)}
				</div>
				{!isRenaming && (
					<div className="flex items-center gap-0.5">
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onAddSession(workspace.id);
							}}
							className="opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity"
							title="New session"
						>
							<Plus className="h-3.5 w-3.5 text-muted-foreground" />
						</button>
						<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									onClick={(e) => e.stopPropagation()}
									className={cn(
										"p-1 rounded hover:bg-muted shrink-0",
										menuOpen
											? "opacity-100"
											: "opacity-0 group-hover:opacity-100",
									)}
									title="More options"
								>
									<MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-32">
								<DropdownMenuItem onClick={startRename}>
									Rename
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => onDeleteWorkspace(workspace)}
									className="text-destructive"
								>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}
			</div>
			{isExpanded && (
				<div className="ml-3">
					{sessionsLoading ? (
						<div className="py-2 px-5 flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							<span>Loading...</span>
						</div>
					) : sessions.length > 0 ? (
						sessions.map((session) => (
							<SessionNode
								key={session.id}
								session={session}
								onSessionSelect={onSessionSelect}
								isSelected={selectedSessionId === session.id}
								onClearSelection={onClearSelection}
							/>
						))
					) : (
						<div className="py-2 px-5 text-sm text-muted-foreground">
							<span>No sessions</span>
							<button
								type="button"
								onClick={() => onAddSession(workspace.id)}
								className="ml-2 text-primary hover:underline"
							>
								Create one
							</button>
						</div>
					)}
				</div>
			)}
		</div>
	);
});

function getSessionHoverText(session: Session): string {
	// Show commit error if commit failed
	if (session.commitStatus === CommitStatus.FAILED && session.commitError) {
		return `Commit Failed: ${session.commitError}`;
	}

	const status = session.status
		.replace(/_/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
	if (session.status === SessionStatus.ERROR && session.errorMessage) {
		return `${status}: ${session.errorMessage}`;
	}
	return status;
}

function getWorkspaceStatusIndicator(status: WorkspaceStatus) {
	switch (status) {
		case WorkspaceStatusConstants.INITIALIZING:
		case WorkspaceStatusConstants.CLONING:
			return <Loader2 className="h-3.5 w-3.5 text-yellow-500 animate-spin" />;
		case WorkspaceStatusConstants.ERROR:
			return <Circle className="h-3 w-3 text-destructive fill-destructive" />;
		default:
			return null;
	}
}

const SessionNode = React.memo(function SessionNode({
	session,
	onSessionSelect,
	isSelected,
	onClearSelection,
}: {
	session: Session;
	onSessionSelect: (session: { id: string }) => void;
	isSelected: boolean;
	onClearSelection: () => void;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [isRenaming, setIsRenaming] = React.useState(false);
	const [editedName, setEditedName] = React.useState("");
	const { deleteSession } = useDeleteSession();
	const { updateSession } = useSession(session.id);
	const inputRef = React.useRef<HTMLInputElement>(null);

	// Focus input when entering rename mode
	React.useEffect(() => {
		if (isRenaming && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isRenaming]);

	const startRename = () => {
		setEditedName(session.displayName || "");
		setIsRenaming(true);
		setMenuOpen(false);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setEditedName("");
	};

	const saveRename = async () => {
		const trimmedName = editedName.trim();
		// If unchanged, just cancel
		if (trimmedName === (session.displayName || "")) {
			cancelRename();
			return;
		}

		try {
			// If empty, pass null to clear the display name and revert to original name
			await updateSession({
				displayName: trimmedName === "" ? null : trimmedName,
			});
			setIsRenaming(false);
		} catch (error) {
			console.error("Failed to rename session:", error);
			// Keep in rename mode on error
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	};

	const handleDelete = async () => {
		const wasSelected = isSelected;
		await deleteSession(session.id);
		// If the deleted session was currently selected, go to welcome screen
		if (wasSelected) {
			onClearSelection();
		}
	};

	const showTooltip =
		session.commitStatus === CommitStatus.FAILED ||
		session.status === SessionStatus.ERROR;
	const tooltipText = getSessionHoverText(session);

	// Get the display name (displayName if set, otherwise original name)
	const displayName = getSessionDisplayName(session);

	const sessionButton = (
		<button
			type="button"
			onClick={() => !isRenaming && onSessionSelect(session)}
			className="flex items-center gap-1.5 min-w-0 flex-1"
			title={
				isRenaming
					? undefined
					: session.displayName
						? `${session.displayName} (${session.name})`
						: !showTooltip && session.status !== "ready"
							? tooltipText
							: undefined
			}
		>
			<span className="shrink-0 flex items-center justify-center w-4 h-4">
				{getSessionStatusIndicator(session, "small")}
			</span>
			{isRenaming ? (
				<input
					ref={inputRef}
					type="text"
					value={editedName}
					onChange={(e) => setEditedName(e.target.value)}
					onKeyDown={handleKeyDown}
					onBlur={saveRename}
					onClick={(e) => e.stopPropagation()}
					className="flex-1 min-w-0 px-1 py-0.5 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
					placeholder={session.name}
				/>
			) : (
				<span className="truncate text-sm">{displayName}</span>
			)}
		</button>
	);

	return (
		<div
			className={cn(
				"group flex items-center gap-1.5 py-1 hover:bg-sidebar-accent text-sm transition-colors cursor-pointer",
				isSelected && "bg-sidebar-accent",
			)}
			style={{ paddingLeft: "20px", paddingRight: "8px" }}
		>
			{showTooltip && !isRenaming ? (
				<Tooltip>
					<TooltipTrigger asChild>{sessionButton}</TooltipTrigger>
					<TooltipContent
						side="right"
						className="max-w-xs bg-destructive text-destructive-foreground"
					>
						{tooltipText}
					</TooltipContent>
				</Tooltip>
			) : (
				sessionButton
			)}
			{!isRenaming && (
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							onClick={(e) => e.stopPropagation()}
							className={cn(
								"p-0.5 rounded hover:bg-muted shrink-0",
								menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<MoreHorizontal className="h-4 w-4 text-muted-foreground" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-32">
						<DropdownMenuItem onClick={startRename}>Rename</DropdownMenuItem>
						<DropdownMenuItem
							onClick={handleDelete}
							className="text-destructive"
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
});
