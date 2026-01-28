import {
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
import { Button } from "@/components/ui/button";
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
	SessionStatus as SessionStatusConstants,
} from "@/lib/api-constants";
import type { Session } from "@/lib/api-types";
import { useMainPanelContext } from "@/lib/contexts/main-panel-context";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import {
	useDeleteSession,
	useSession,
	useSessions,
} from "@/lib/hooks/use-sessions";
import {
	getSessionStatusColor,
	getSessionStatusIndicator,
} from "@/lib/session-utils";
import { cn, formatTimeAgo } from "@/lib/utils";

interface SessionListTableProps {
	workspaceId: string;
	workspaceName: string;
	onSessionSelect: (session: { id: string }) => void;
	onClose?: () => void;
	showClosedSessions?: boolean;
}

export function SessionListTable({
	workspaceId,
	workspaceName,
	onSessionSelect,
	onClose,
	showClosedSessions = false,
}: SessionListTableProps) {
	const { sessions, isLoading } = useSessions(workspaceId, {
		includeClosed: showClosedSessions,
	});
	const { showNewSession } = useMainPanelContext();

	const handleNewSession = () => {
		showNewSession({ workspaceId });
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
						{onClose && (
							<button
								type="button"
								onClick={onClose}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors px-3"
							>
								Close
							</button>
						)}
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
						<Button onClick={() => showNewSession({ workspaceId })}>
							<Plus className="h-4 w-4 mr-2" />
							Create Session
						</Button>
					</div>
				) : (
					<div className="border-b border-border">
						{sessions.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								onSessionSelect={onSessionSelect}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function SessionRow({
	session,
	onSessionSelect,
}: {
	session: Session;
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
		<button
			type="button"
			className="group flex items-center gap-4 px-6 py-4 border-b border-border hover:bg-muted/50 cursor-pointer transition-colors w-full text-left"
			onClick={() => !isRenaming && onSessionSelect(session)}
		>
			{/* Status Icon and Text */}
			<div className="flex items-center gap-2 shrink-0 w-32">
				<div className="flex items-center justify-center w-5 h-5 self-start mt-0.5">
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

			{/* Session Name and Description */}
			<div className="flex-1 min-w-0">
				{isRenaming ? (
					<div className="flex items-center gap-2">
						<input
							ref={inputRef}
							type="text"
							value={editedName}
							onChange={(e) => setEditedName(e.target.value)}
							onKeyDown={handleKeyDown}
							onClick={(e) => e.stopPropagation()}
							className="flex-1 min-w-0 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring font-medium"
							placeholder={session.name}
						/>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								saveRename();
							}}
							className="p-1 rounded hover:bg-muted text-green-600 hover:text-green-700"
							title="Save (Enter)"
						>
							<Check className="h-4 w-4" />
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								cancelRename();
							}}
							className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
							title="Cancel (Esc)"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
				) : (
					<>
						<h3 className="font-medium break-words">{displayName}</h3>
						{session.description && (
							<p className="text-sm text-muted-foreground truncate mt-0.5">
								{session.description}
							</p>
						)}
					</>
				)}
			</div>

			{/* Agent */}
			{agent && (
				<div className="flex items-center gap-1.5 shrink-0 w-40">
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

			{/* Base Commit */}
			{session.baseCommit && (
				<div className="text-xs text-muted-foreground shrink-0 w-28">
					<span className="truncate block font-mono" title={session.baseCommit}>
						{session.baseCommit.slice(0, 7)}
					</span>
				</div>
			)}

			{/* Applied Commit */}
			{session.appliedCommit && (
				<div className="text-xs text-muted-foreground shrink-0 w-28">
					<span
						className="truncate block font-mono"
						title={session.appliedCommit}
					>
						→ {session.appliedCommit.slice(0, 7)}
					</span>
				</div>
			)}

			{/* Timestamp */}
			<div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0 w-32">
				<Clock className="h-3.5 w-3.5" />
				<span>{formatTimeAgo(session.timestamp)}</span>
			</div>

			{/* Actions */}
			<div className="shrink-0">
				<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							onClick={(e) => e.stopPropagation()}
							className={cn(
								"p-1.5 rounded hover:bg-muted transition-opacity",
								menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<MoreHorizontal className="h-4 w-4 text-muted-foreground" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-32">
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								startRename();
							}}
						>
							Rename
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								handleDelete();
							}}
							className="text-destructive"
						>
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</button>
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
