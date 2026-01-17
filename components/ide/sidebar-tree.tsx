"use client";

import { SiGithub } from "@icons-pack/react-simple-icons";
import {
	Archive,
	ChevronDown,
	ChevronRight,
	Circle,
	CircleHelp,
	Eye,
	EyeOff,
	GitBranch,
	HardDrive,
	Loader2,
	MoreHorizontal,
	Pause,
	Plus,
} from "lucide-react";
import * as React from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Session, Workspace, WorkspaceStatus } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useDeleteSession, useSessions } from "@/lib/hooks/use-sessions";
import { cn } from "@/lib/utils";

function parseWorkspacePath(path: string, sourceType: "local" | "git") {
	if (sourceType === "local") {
		return { displayPath: path, isGitHub: false };
	}

	const githubHttpMatch = path.match(/github\.com\/([^/]+\/[^/]+)/);
	const githubSshMatch = path.match(
		/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
	);

	if (githubHttpMatch) {
		return { displayPath: githubHttpMatch[1], isGitHub: true };
	}
	if (githubSshMatch) {
		return { displayPath: githubSshMatch[1], isGitHub: true };
	}

	const stripped = path
		.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
		.replace(/\.git$/, "");
	return { displayPath: stripped, isGitHub: false };
}

interface SidebarTreeProps {
	className?: string;
}

const STORAGE_KEY = "sidebar-expanded-workspaces";

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
	const {
		workspaces,
		selectedSessionId,
		handleSessionSelect,
		handleAddSession,
	} = useSessionContext();
	const { openWorkspaceDialog, openDeleteWorkspaceDialog } = useDialogContext();

	const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
	const [showClosed, setShowClosed] = React.useState(false);

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
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={openWorkspaceDialog}
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
						title="Add workspace"
					>
						<Plus className="h-3.5 w-3.5 text-muted-foreground" />
					</button>
					<button
						type="button"
						onClick={() => setShowClosed(!showClosed)}
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
						title={showClosed ? "Hide closed sessions" : "Show closed sessions"}
					>
						{showClosed ? (
							<Eye className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</button>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto py-1">
				{workspaces.map((workspace) => (
					<WorkspaceNode
						key={workspace.id}
						workspace={workspace}
						expandedIds={expandedIds}
						toggleExpand={toggleExpand}
						onSessionSelect={handleSessionSelect}
						selectedSessionId={selectedSessionId}
						showClosed={showClosed}
						onAddSession={handleAddSession}
						onDeleteWorkspace={openDeleteWorkspaceDialog}
					/>
				))}
			</div>
		</div>
	);
}

function WorkspaceNode({
	workspace,
	expandedIds,
	toggleExpand,
	onSessionSelect,
	selectedSessionId,
	showClosed,
	onAddSession,
	onDeleteWorkspace,
}: {
	workspace: Workspace;
	expandedIds: Set<string>;
	toggleExpand: (id: string) => void;
	onSessionSelect: (session: { id: string }) => void;
	selectedSessionId: string | null;
	showClosed: boolean;
	onAddSession: (workspaceId: string) => void;
	onDeleteWorkspace: (workspace: Workspace) => void;
}) {
	const isExpanded = expandedIds.has(workspace.id);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const { displayPath, isGitHub } = parseWorkspacePath(
		workspace.path,
		workspace.sourceType,
	);

	// Fetch sessions when workspace is expanded
	const { sessions, isLoading: sessionsLoading } = useSessions(
		isExpanded ? workspace.id : null,
	);

	const visibleSessions = showClosed
		? sessions
		: sessions.filter((s) => s.status !== "closed");

	return (
		<div>
			{/* biome-ignore lint/a11y/useSemanticElements: Complex interactive pattern with nested action button */}
			<div
				className={cn(
					"group flex items-center px-2 py-1 hover:bg-sidebar-accent transition-colors cursor-pointer",
				)}
				onClick={() => toggleExpand(workspace.id)}
				onKeyDown={(e) => e.key === "Enter" && toggleExpand(workspace.id)}
				role="button"
				tabIndex={0}
			>
				<div className="flex items-center gap-1.5 min-w-0 flex-1">
					{isExpanded ? (
						<ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
					)}
					{getWorkspaceStatusIndicator(workspace.status) ??
						(workspace.sourceType === "git" ? (
							isGitHub ? (
								<SiGithub className="h-4 w-4 shrink-0" />
							) : (
								<GitBranch className="h-4 w-4 text-orange-500 shrink-0" />
							)
						) : (
							<HardDrive className="h-4 w-4 text-blue-500 shrink-0" />
						))}
					<span className="font-mono truncate text-sm">{displayPath}</span>
				</div>
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
							<DropdownMenuItem
								onClick={() => onDeleteWorkspace(workspace)}
								className="text-destructive"
							>
								Delete
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{isExpanded && (
				<div className="ml-3">
					{sessionsLoading ? (
						<div className="py-2 px-5 flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="h-3 w-3 animate-spin" />
							<span>Loading...</span>
						</div>
					) : visibleSessions.length > 0 ? (
						visibleSessions.map((session) => (
							<SessionNode
								key={session.id}
								session={session}
								onSessionSelect={onSessionSelect}
								isSelected={selectedSessionId === session.id}
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
}

function getSessionHoverText(session: Session): string {
	const status = session.status
		.replace(/_/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
	if (session.status === "error" && session.errorMessage) {
		return `${status}: ${session.errorMessage}`;
	}
	return status;
}

function getSessionStatusIndicator(status: Session["status"]) {
	switch (status) {
		case "initializing":
		case "reinitializing":
		case "cloning":
		case "pulling_image":
		case "creating_sandbox":
		case "starting_agent":
			return <Loader2 className="h-2.5 w-2.5 text-yellow-500 animate-spin" />;
		case "running":
			return <Circle className="h-2.5 w-2.5 text-green-500 fill-green-500" />;
		case "stopped":
			return <Pause className="h-2.5 w-2.5 text-muted-foreground" />;
		case "error":
			return (
				<Circle className="h-2.5 w-2.5 text-destructive fill-destructive" />
			);
		case "closed":
			return <Archive className="h-2.5 w-2.5 text-muted-foreground" />;
		case "removing":
			return <Loader2 className="h-2.5 w-2.5 text-red-500 animate-spin" />;
		default:
			return <CircleHelp className="h-2.5 w-2.5 text-muted-foreground" />;
	}
}

function getWorkspaceStatusIndicator(status: WorkspaceStatus) {
	switch (status) {
		case "initializing":
		case "cloning":
			return <Loader2 className="h-3.5 w-3.5 text-yellow-500 animate-spin" />;
		case "error":
			return <Circle className="h-3 w-3 text-destructive fill-destructive" />;
		default:
			return null;
	}
}

function SessionNode({
	session,
	onSessionSelect,
	isSelected,
}: {
	session: Session;
	onSessionSelect: (session: { id: string }) => void;
	isSelected: boolean;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const { deleteSession } = useDeleteSession();

	const handleRename = () => {
		console.log("Rename session:", session.id);
	};

	const handleDelete = async () => {
		await deleteSession(session.id, session.workspaceId);
	};

	return (
		<div
			className={cn(
				"group flex items-center gap-1.5 py-1 hover:bg-sidebar-accent text-sm transition-colors cursor-pointer",
				isSelected && "bg-sidebar-accent",
				session.status === "closed" && "opacity-60",
			)}
			style={{ paddingLeft: "20px", paddingRight: "8px" }}
		>
			<button
				type="button"
				onClick={() => onSessionSelect(session)}
				className="flex items-center gap-1.5 min-w-0 flex-1"
				title={
					session.status !== "running"
						? getSessionHoverText(session)
						: undefined
				}
			>
				<span className="shrink-0 flex items-center justify-center w-4 h-4">
					{getSessionStatusIndicator(session.status)}
				</span>
				<span className="truncate text-sm">{session.name}</span>
			</button>
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
					<DropdownMenuItem onClick={handleRename}>Rename</DropdownMenuItem>
					<DropdownMenuItem onClick={handleDelete} className="text-destructive">
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
