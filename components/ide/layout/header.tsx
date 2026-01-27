"use client";

import {
	Bot,
	Check,
	ChevronDown,
	Key,
	PanelLeft,
	PanelLeftClose,
	Plus,
} from "lucide-react";
import * as React from "react";
import { CredentialsDialog } from "@/components/ide/dialogs/credentials-dialog";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { OctobotLogo } from "@/components/ide/octobot-logo";
import { SessionDropdownItem } from "@/components/ide/session-dropdown-item";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { WindowControls } from "@/components/ide/window-controls";
import { WorkspaceDisplay } from "@/components/ide/workspace-display";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api-client";
import type { Agent, Workspace } from "@/lib/api-types";
import { useAgentContext } from "@/lib/contexts/agent-context";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useDeleteSession, useSessions } from "@/lib/hooks/use-sessions";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import {
	getSessionHoverText,
	getSessionStatusIndicator,
} from "@/lib/session-utils";
import { IS_TAURI } from "@/lib/tauri";

interface HeaderProps {
	leftSidebarOpen: boolean;
	onToggleSidebar: () => void;
	onNewSession: () => void;
}

export function Header({
	leftSidebarOpen,
	onToggleSidebar,
	onNewSession,
}: HeaderProps) {
	const { workspaces } = useWorkspaces();
	const { agents, agentTypes } = useAgentContext();
	const { selectedSession, handleSessionSelect } = useSessionContext();

	// Derive sessionAgent and sessionWorkspace from selectedSession
	const sessionAgent = selectedSession
		? agents.find((a) => a.id === selectedSession.agentId)
		: undefined;
	const sessionWorkspace = selectedSession
		? workspaces.find((w) => w.id === selectedSession.workspaceId)
		: undefined;

	const [credentialsOpen, setCredentialsOpen] = React.useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(
		null,
	);

	const getAgentIcons = (a: Agent) => {
		const agentType = agentTypes.find((t) => t.id === a.agentType);
		return agentType?.icons;
	};

	// Fetch sessions for current workspace via SWR
	const { sessions: workspaceSessions } = useSessions(
		sessionWorkspace?.id ?? null,
	);

	const hasSession = selectedSession || sessionWorkspace;

	// Handle workspace selection from breadcrumb dropdown
	const handleWorkspaceSelect = React.useCallback(
		async (workspace: Workspace) => {
			// Fetch sessions for this workspace and select the first one
			try {
				const { sessions } = await api.getSessions(workspace.id);
				const firstSession = sessions[0];
				if (firstSession) {
					handleSessionSelect(firstSession);
				}
			} catch (error) {
				console.error("Failed to fetch sessions for workspace:", error);
			}
		},
		[handleSessionSelect],
	);

	// Handle session deletion with inline confirmation
	const { deleteSession } = useDeleteSession();
	const handleDeleteClick = React.useCallback(
		(e: React.MouseEvent, sessionId: string) => {
			e.stopPropagation();
			setConfirmDeleteId(sessionId);
		},
		[],
	);
	const handleConfirmDelete = React.useCallback(
		async (e: React.MouseEvent, sessionId: string) => {
			e.stopPropagation();
			const isCurrentSession = selectedSession?.id === sessionId;
			await deleteSession(sessionId);
			setConfirmDeleteId(null);
			if (isCurrentSession) {
				onNewSession();
			}
		},
		[deleteSession, selectedSession?.id, onNewSession],
	);
	const handleCancelDelete = React.useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setConfirmDeleteId(null);
	}, []);

	// Detect macOS for window control placement
	const [isMac, setIsMac] = React.useState(false);
	React.useEffect(() => {
		if (!IS_TAURI) return;
		import("@tauri-apps/plugin-os").then(({ platform }) => {
			setIsMac(platform() === "macos");
		});
	}, []);

	return (
		<header className="h-12 border-b border-border flex items-center justify-between px-4 relative z-[60] bg-background">
			{/* Drag region layer - covers header but behind content */}
			<div
				className="absolute inset-0 pointer-events-auto"
				data-tauri-drag-region
			/>
			<div className="flex items-center gap-2 min-w-0 relative">
				{/* macOS window controls on the left */}
				{IS_TAURI && isMac && <WindowControls />}
				<Button
					variant="ghost"
					size="icon"
					onClick={onToggleSidebar}
					className="tauri-no-drag"
				>
					{leftSidebarOpen ? (
						<PanelLeftClose className="h-4 w-4" />
					) : (
						<PanelLeft className="h-4 w-4" />
					)}
				</Button>
				<div className="flex items-center gap-1.5 shrink-0">
					<OctobotLogo size={22} className="text-primary" />
					<span className="font-semibold">Octobot</span>
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="gap-1.5 text-muted-foreground shrink-0 tauri-no-drag"
					onClick={onNewSession}
				>
					<Plus className="h-4 w-4" />
					New Session
				</Button>

				{/* Breadcrumbs with dropdowns */}
				{hasSession && (
					<>
						<span className="text-muted-foreground shrink-0">/</span>

						{/* Workspace dropdown */}
						{sessionWorkspace && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0 tauri-no-drag"
									>
										<WorkspaceDisplay
											workspace={sessionWorkspace}
											iconSize={16}
											iconClassName="h-4 w-4"
											textClassName="truncate max-w-[150px]"
											showTooltip={false}
										/>
										<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="w-64">
									{workspaces.map((ws) => {
										const isSelected = ws.id === sessionWorkspace.id;
										return (
											<DropdownMenuItem
												key={ws.id}
												onClick={() => handleWorkspaceSelect(ws)}
												className="flex items-center gap-2"
											>
												<WorkspaceDisplay
													workspace={ws}
													iconSize={16}
													iconClassName="h-4 w-4"
													textClassName="flex-1"
													showTooltip={false}
												/>
												{isSelected && (
													<Check className="h-4 w-4 shrink-0 text-primary" />
												)}
											</DropdownMenuItem>
										);
									})}
								</DropdownMenuContent>
							</DropdownMenu>
						)}

						{/* Session dropdown */}
						{selectedSession && sessionWorkspace && (
							<>
								<span className="text-muted-foreground shrink-0">/</span>
								<DropdownMenu
									onOpenChange={(open) => !open && setConfirmDeleteId(null)}
								>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0 tauri-no-drag"
											title={
												selectedSession.commitStatus === "failed" ||
												selectedSession.status === "error"
													? getSessionHoverText(selectedSession)
													: undefined
											}
										>
											{getSessionStatusIndicator(selectedSession)}
											<span className="truncate max-w-[200px] font-medium">
												{selectedSession.name}
											</span>
											<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="w-72">
										{workspaceSessions.length > 0 ? (
											workspaceSessions.map((session) => (
												<SessionDropdownItem
													key={session.id}
													session={session}
													isSelected={session.id === selectedSession.id}
													isConfirming={confirmDeleteId === session.id}
													onSelect={() => handleSessionSelect(session)}
													onDeleteClick={(e) =>
														handleDeleteClick(e, session.id)
													}
													onConfirmDelete={(e) =>
														handleConfirmDelete(e, session.id)
													}
													onCancelDelete={handleCancelDelete}
												/>
											))
										) : (
											<div className="px-2 py-4 text-sm text-muted-foreground text-center">
												No open sessions
											</div>
										)}
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={onNewSession}
											className="flex items-center gap-2"
										>
											<Plus className="h-4 w-4 shrink-0" />
											<span>New Session</span>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</>
						)}

						{/* Agent badge (non-interactive) */}
						{sessionAgent && (
							<>
								<span className="text-muted-foreground shrink-0">/</span>
								<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
									{getAgentIcons(sessionAgent) ? (
										<IconRenderer
											icons={getAgentIcons(sessionAgent)}
											size={16}
											className="shrink-0"
										/>
									) : (
										<Bot className="h-4 w-4 shrink-0" />
									)}
									<span className="truncate">{sessionAgent.name}</span>
								</div>
							</>
						)}
					</>
				)}
			</div>
			<div className="flex items-center gap-1 shrink-0 relative">
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setCredentialsOpen(true)}
					title="API Credentials"
					className="tauri-no-drag"
				>
					<Key className="h-4 w-4" />
					<span className="sr-only">API Credentials</span>
				</Button>
				<ThemeToggle className="tauri-no-drag" />
				{/* Windows/Linux window controls on the right */}
				{IS_TAURI && !isMac && <WindowControls />}
			</div>

			<CredentialsDialog
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
			/>
		</header>
	);
}
