"use client";

import {
	ArrowDown,
	ArrowUp,
	Bot,
	Check,
	Clock,
	Loader2,
	MoreHorizontal,
	Plus,
	X,
} from "lucide-react";
import * as React from "react";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { getSessionDisplayName } from "@/components/ide/session-name";
import { getWorkspaceDisplayPath } from "@/components/ide/workspace-path";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	CommitStatus,
	SessionStatus as SessionStatusConstants,
} from "@/lib/api-constants";
import type { Session, Workspace } from "@/lib/api-types";
import { useMainContentContext } from "@/lib/contexts/main-content-context";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
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
import {
	getSessionStatusColor,
	getSessionStatusIndicator,
} from "@/lib/session-utils";
import { cn, formatTimeAgo } from "@/lib/utils";

export function SessionListTable() {
	const { view, showSession, showNewSession } = useMainContentContext();
	const { workspaces } = useWorkspaces();

	// Get workspace ID from view
	const workspaceId =
		view.type === "workspace-sessions" ? view.workspaceId : null;

	// Find the workspace
	const selectedWorkspace = workspaceId
		? workspaces.find((w) => w.id === workspaceId)
		: null;

	const workspaceName = selectedWorkspace
		? selectedWorkspace.displayName ||
			getWorkspaceDisplayPath(
				selectedWorkspace.path,
				selectedWorkspace.sourceType,
			)
		: "";

	// Get show closed sessions preference
	const [showClosedSessions] = usePersistedState(
		STORAGE_KEYS.SHOW_CLOSED_SESSIONS,
		false,
	);

	const { sessions, isLoading } = useSessions(workspaceId, {
		includeClosed: showClosedSessions,
	});

	// Sorting state
	type SortColumn = "status" | "name" | "agent" | "timestamp";
	type SortDirection = "asc" | "desc";
	const [sortColumn, setSortColumn] = React.useState<SortColumn>("timestamp");
	const [sortDirection, setSortDirection] =
		React.useState<SortDirection>("desc");

	// Sort sessions
	const sortedSessions = React.useMemo(() => {
		const sorted = [...sessions];
		sorted.sort((a, b) => {
			let aValue: string | number;
			let bValue: string | number;

			switch (sortColumn) {
				case "status":
					aValue = a.status;
					bValue = b.status;
					break;
				case "name":
					aValue = a.displayName || a.name;
					bValue = b.displayName || b.name;
					break;
				case "agent":
					aValue = a.agentId || "";
					bValue = b.agentId || "";
					break;
				case "timestamp":
					aValue = new Date(a.timestamp).getTime();
					bValue = new Date(b.timestamp).getTime();
					break;
				default:
					return 0;
			}

			if (aValue < bValue) return sortDirection === "asc" ? -1 : 1;
			if (aValue > bValue) return sortDirection === "asc" ? 1 : -1;
			return 0;
		});
		return sorted;
	}, [sessions, sortColumn, sortDirection]);

	const handleSort = (column: SortColumn) => {
		if (sortColumn === column) {
			// Toggle direction
			setSortDirection(sortDirection === "asc" ? "desc" : "asc");
		} else {
			// New column, default to ascending
			setSortColumn(column);
			setSortDirection("asc");
		}
	};

	const SortIcon = ({ column }: { column: SortColumn }) => {
		if (sortColumn !== column) return null;
		return sortDirection === "asc" ? (
			<ArrowUp className="h-3.5 w-3.5" />
		) : (
			<ArrowDown className="h-3.5 w-3.5" />
		);
	};

	const handleNewSession = () => {
		if (workspaceId) {
			showNewSession({ workspaceId });
		}
	};

	const handleSessionSelect = (session: { id: string }) => {
		showSession(session.id);
	};

	const handleClose = () => {
		showNewSession();
	};

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<div className="flex items-center gap-2 text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					<span>Loading sessions...</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden bg-background">
			{/* Header */}
			<div className="border-b border-border px-6 py-4">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-2xl font-semibold">{workspaceName}</h1>
						<p className="text-sm text-muted-foreground mt-1">
							{sessions.length} {sessions.length === 1 ? "session" : "sessions"}
						</p>
					</div>
					<div className="flex items-center gap-2">
						<Button onClick={handleNewSession} size="sm">
							<Plus className="h-4 w-4 mr-1" />
							New Session
						</Button>
						<button
							type="button"
							onClick={handleClose}
							className="text-sm text-muted-foreground hover:text-foreground transition-colors px-3"
						>
							Close
						</button>
					</div>
				</div>
			</div>

			{/* Table */}
			<div className="flex-1 overflow-y-auto">
				{sessions.length === 0 ? (
					<div className="flex flex-col items-center justify-center h-64 gap-4">
						<p className="text-muted-foreground">
							No sessions found. Create one to get started.
						</p>
						<Button onClick={handleNewSession}>
							<Plus className="h-4 w-4 mr-2" />
							Create Session
						</Button>
					</div>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead className="w-[140px]">
									<button
										type="button"
										onClick={() => handleSort("status")}
										className="flex items-center gap-1.5 hover:text-foreground transition-colors"
									>
										Status
										<SortIcon column="status" />
									</button>
								</TableHead>
								<TableHead>
									<button
										type="button"
										onClick={() => handleSort("name")}
										className="flex items-center gap-1.5 hover:text-foreground transition-colors"
									>
										Session
										<SortIcon column="name" />
									</button>
								</TableHead>
								<TableHead className="w-[180px]">
									<button
										type="button"
										onClick={() => handleSort("agent")}
										className="flex items-center gap-1.5 hover:text-foreground transition-colors"
									>
										Agent
										<SortIcon column="agent" />
									</button>
								</TableHead>
								<TableHead className="w-[100px]">Base</TableHead>
								<TableHead className="w-[100px]">Applied</TableHead>
								<TableHead className="w-[140px]">
									<button
										type="button"
										onClick={() => handleSort("timestamp")}
										className="flex items-center gap-1.5 hover:text-foreground transition-colors"
									>
										Updated
										<SortIcon column="timestamp" />
									</button>
								</TableHead>
								<TableHead className="w-[60px]"></TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{sortedSessions.map((session) => (
								<SessionRow
									key={session.id}
									session={session}
									workspace={selectedWorkspace}
									onSessionSelect={handleSessionSelect}
								/>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}

function SessionRow({
	session,
	workspace,
	onSessionSelect,
}: {
	session: Session;
	workspace: Workspace | null | undefined;
	onSessionSelect: (session: { id: string }) => void;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [isRenaming, setIsRenaming] = React.useState(false);
	const [editedName, setEditedName] = React.useState("");
	const { deleteSession } = useDeleteSession();
	const { updateSession } = useSession(session.id);
	const { agents } = useAgents();
	const { agentTypes } = useAgentTypes();
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
			// Pass the trimmed name (even if empty string)
			// The server treats empty string as clearing the displayName
			await updateSession({
				displayName: trimmedName,
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
		await deleteSession(session.id);
	};

	const showTooltip =
		session.commitStatus === CommitStatus.FAILED ||
		session.status === SessionStatusConstants.ERROR;

	const getStatusText = () => {
		if (session.commitStatus === CommitStatus.FAILED && session.commitError) {
			return `Commit Failed: ${session.commitError}`;
		}
		if (
			session.status === SessionStatusConstants.ERROR &&
			session.errorMessage
		) {
			return `Error: ${session.errorMessage}`;
		}
		// Convert to uppercase with spaces
		const statusText = session.status.replace(/_/g, " ").toUpperCase();
		return statusText;
	};

	const statusIndicator = getSessionStatusIndicator(session, "small");
	const statusText = getStatusText();
	const statusColor = getSessionStatusColor(session);
	const displayName = getSessionDisplayName(session);

	// Get agent info for icon display
	const agent = agents.find((a) => a.id === session.agentId);
	const agentType = agentTypes.find((t) => t.id === agent?.agentType);
	const agentIcons = agentType?.icons;

	const rowContent = (
		<TableRow className="group">
			{/* Status */}
			<TableCell>
				<div className="flex items-center gap-2">
					<div className="flex items-center justify-center w-5 h-5">
						{statusIndicator}
					</div>
					<div className="flex flex-col gap-0.5 min-w-0">
						<span className={cn("text-xs font-medium", statusColor)}>
							{statusText}
						</span>
						{session.commitStatus === CommitStatus.COMPLETED &&
							session.appliedCommit && (
								<span
									className="text-xs text-muted-foreground truncate"
									title={`Committed: ${session.appliedCommit}`}
								>
									{session.appliedCommit.slice(0, 7)}
								</span>
							)}
					</div>
				</div>
			</TableCell>

			{/* Session Name and Description */}
			<TableCell className="max-w-0">
				{isRenaming ? (
					<div className="flex items-center gap-2">
						<input
							ref={inputRef}
							type="text"
							value={editedName}
							onChange={(e) => setEditedName(e.target.value)}
							onKeyDown={handleKeyDown}
							className="flex-1 min-w-0 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-medium"
							placeholder={session.name}
						/>
						<button
							type="button"
							onClick={saveRename}
							className="p-1 rounded hover:bg-muted text-green-600 hover:text-green-700"
							title="Save (Enter)"
						>
							<Check className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={cancelRename}
							className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
							title="Cancel (Esc)"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				) : (
					<div className="min-w-0 overflow-hidden">
						<button
							type="button"
							onClick={() => onSessionSelect(session)}
							className="font-medium hover:underline text-left truncate block"
						>
							{displayName}
						</button>
						{session.description && (
							<p className="text-sm text-muted-foreground truncate mt-0.5">
								{session.description}
							</p>
						)}
					</div>
				)}
			</TableCell>

			{/* Agent */}
			<TableCell>
				{agent && (
					<div className="flex items-center gap-1.5">
						{agentIcons && agentIcons.length > 0 ? (
							<IconRenderer icons={agentIcons} size={16} className="shrink-0" />
						) : (
							<Bot className="h-4 w-4 text-muted-foreground shrink-0" />
						)}
						<span className="text-xs text-muted-foreground truncate">
							{agent.name}
						</span>
					</div>
				)}
			</TableCell>

			{/* Base Commit */}
			<TableCell>
				{session.baseCommit ? (
					<span
						className="text-xs text-muted-foreground font-mono"
						title={`Base: ${session.baseCommit}`}
					>
						{session.baseCommit.slice(0, 7)}
					</span>
				) : workspace?.commit ? (
					<span
						className="text-xs text-muted-foreground/60 font-mono italic"
						title={`Workspace: ${workspace.commit}`}
					>
						{workspace.commit.slice(0, 7)}
					</span>
				) : null}
			</TableCell>

			{/* Applied Commit */}
			<TableCell>
				{session.appliedCommit && (
					<span
						className="text-xs text-muted-foreground font-mono"
						title={session.appliedCommit}
					>
						→ {session.appliedCommit.slice(0, 7)}
					</span>
				)}
			</TableCell>

			{/* Timestamp */}
			<TableCell>
				<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Clock className="h-3.5 w-3.5" />
					<span>{formatTimeAgo(session.timestamp)}</span>
				</div>
			</TableCell>

			{/* Actions */}
			<TableCell>
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className={cn(
								"p-1.5 rounded hover:bg-muted transition-opacity",
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
			</TableCell>
		</TableRow>
	);

	if (showTooltip) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{rowContent}</TooltipTrigger>
				<TooltipContent
					side="top"
					className="max-w-xs bg-destructive text-destructive-foreground"
				>
					{statusText}
				</TooltipContent>
			</Tooltip>
		);
	}

	return rowContent;
}
