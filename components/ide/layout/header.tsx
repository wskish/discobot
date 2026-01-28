"use client";

import {
	ChevronDown,
	Key,
	PanelLeft,
	PanelLeftClose,
	Plus,
} from "lucide-react";
import * as React from "react";
import { CredentialsDialog } from "@/components/ide/dialogs/credentials-dialog";
import { OctobotLogo } from "@/components/ide/octobot-logo";
import { SessionDropdownItem } from "@/components/ide/session-dropdown-item";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { WindowControls } from "@/components/ide/window-controls";
import { WorkspaceDisplay } from "@/components/ide/workspace-display";
import { WorkspaceDropdownItem } from "@/components/ide/workspace-dropdown-item";
import { getWorkspaceDisplayPath } from "@/components/ide/workspace-path";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Workspace } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useMainPanelContext } from "@/lib/contexts/main-panel-context";
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
}

export function Header({ leftSidebarOpen, onToggleSidebar }: HeaderProps) {
	const { workspaces, deleteWorkspace } = useWorkspaces();
	const dialogs = useDialogContext();
	const {
		getSelectedSessionId,
		getSelectedWorkspaceId,
		selectedSession,
		isSessionLoading,
		showSession,
		showWorkspaceSessions,
		showNewSession,
	} = useMainPanelContext();

	const _selectedSessionId = getSelectedSessionId();
	const selectedWorkspaceId = getSelectedWorkspaceId();

	// Find the workspace using the helper method
	const sessionWorkspace = selectedWorkspaceId
		? workspaces.find((w) => w.id === selectedWorkspaceId)
		: undefined;

	const [credentialsOpen, setCredentialsOpen] = React.useState(false);
	const [confirmDeleteSessionId, setConfirmDeleteSessionId] = React.useState<
		string | null
	>(null);
	const [confirmDeleteWorkspaceId, setConfirmDeleteWorkspaceId] =
		React.useState<string | null>(null);

	// Fetch sessions for current workspace via SWR
	const { sessions: workspaceSessions } = useSessions(
		sessionWorkspace?.id ?? null,
	);

	// Handle workspace selection from breadcrumb dropdown
	const handleWorkspaceSelect = React.useCallback(
		(workspace: Workspace) => {
			// Show the workspace sessions view
			showWorkspaceSessions(workspace.id);
		},
		[showWorkspaceSessions],
	);

	// Handle workspace deletion with inline confirmation
	const handleWorkspaceDeleteClick = React.useCallback(
		(e: React.MouseEvent, workspaceId: string) => {
			e.stopPropagation();
			setConfirmDeleteWorkspaceId(workspaceId);
		},
		[],
	);
	const handleConfirmWorkspaceDelete = React.useCallback(
		async (e: React.MouseEvent, workspaceId: string) => {
			e.stopPropagation();
			const isCurrentWorkspace = selectedWorkspaceId === workspaceId;
			await deleteWorkspace(workspaceId);
			setConfirmDeleteWorkspaceId(null);
			if (isCurrentWorkspace) {
				showNewSession();
			}
		},
		[deleteWorkspace, selectedWorkspaceId, showNewSession],
	);
	const handleCancelWorkspaceDelete = React.useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			setConfirmDeleteWorkspaceId(null);
		},
		[],
	);

	// Handle session deletion with inline confirmation
	const { deleteSession } = useDeleteSession();
	const handleSessionDeleteClick = React.useCallback(
		(e: React.MouseEvent, sessionId: string) => {
			e.stopPropagation();
			setConfirmDeleteSessionId(sessionId);
		},
		[],
	);
	const handleConfirmSessionDelete = React.useCallback(
		async (e: React.MouseEvent, sessionId: string) => {
			e.stopPropagation();
			const isCurrentSession = selectedSession?.id === sessionId;
			await deleteSession(sessionId);
			setConfirmDeleteSessionId(null);
			if (isCurrentSession) {
				showNewSession();
			}
		},
		[deleteSession, selectedSession?.id, showNewSession],
	);
	const handleCancelSessionDelete = React.useCallback((e: React.MouseEvent) => {
		e.stopPropagation();
		setConfirmDeleteSessionId(null);
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

				<span className="text-muted-foreground shrink-0">/</span>

				{/* Workspace dropdown */}
				{isSessionLoading ? (
					<span className="text-sm text-muted-foreground px-2">Loading...</span>
				) : workspaces.length === 0 ? (
					<Button
						variant="ghost"
						size="sm"
						className="gap-1.5 text-muted-foreground shrink-0 tauri-no-drag"
						onClick={() => dialogs.workspaceDialog.open()}
					>
						<Plus className="h-4 w-4" />
						Add Workspace
					</Button>
				) : (
					<DropdownMenu
						onOpenChange={(open) => !open && setConfirmDeleteWorkspaceId(null)}
					>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0 tauri-no-drag"
							>
								{sessionWorkspace ? (
									<>
										<WorkspaceDisplay
											workspace={sessionWorkspace}
											iconSize={16}
											iconClassName="h-4 w-4"
											textClassName="truncate max-w-[150px]"
											showTooltip={true}
										/>
									</>
								) : (
									<span className="text-muted-foreground">
										Select Workspace
									</span>
								)}
								<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-64">
							{workspaces.map((ws) => (
								<WorkspaceDropdownItem
									key={ws.id}
									workspace={ws}
									isSelected={sessionWorkspace?.id === ws.id}
									isConfirming={confirmDeleteWorkspaceId === ws.id}
									onSelect={() => handleWorkspaceSelect(ws)}
									onDeleteClick={(e) => handleWorkspaceDeleteClick(e, ws.id)}
									onConfirmDelete={(e) =>
										handleConfirmWorkspaceDelete(e, ws.id)
									}
									onCancelDelete={handleCancelWorkspaceDelete}
								/>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => dialogs.workspaceDialog.open()}
								className="flex items-center gap-2"
							>
								<Plus className="h-4 w-4 shrink-0" />
								<span>Add Workspace</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}

				{/* Session dropdown - only show if workspace has sessions */}
				{sessionWorkspace && workspaceSessions.length > 0 && (
					<>
						<span className="text-muted-foreground shrink-0">/</span>
						<DropdownMenu
							onOpenChange={(open) => !open && setConfirmDeleteSessionId(null)}
						>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0 tauri-no-drag"
									title={
										selectedSession?.commitStatus === "failed" ||
										selectedSession?.status === "error"
											? getSessionHoverText(selectedSession)
											: undefined
									}
								>
									{selectedSession ? (
										<>
											{getSessionStatusIndicator(selectedSession)}
											<span className="truncate max-w-[200px] font-medium">
												{selectedSession.name}
											</span>
										</>
									) : (
										<span className="text-muted-foreground">
											Select Session
										</span>
									)}
									<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-72">
								{workspaceSessions.map((session) => (
									<SessionDropdownItem
										key={session.id}
										session={session}
										isSelected={selectedSession?.id === session.id}
										isConfirming={confirmDeleteSessionId === session.id}
										onSelect={() => showSession(session.id)}
										onDeleteClick={(e) =>
											handleSessionDeleteClick(e, session.id)
										}
										onConfirmDelete={(e) =>
											handleConfirmSessionDelete(e, session.id)
										}
										onCancelDelete={handleCancelSessionDelete}
									/>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={() =>
										showNewSession({
											workspaceId: selectedWorkspaceId ?? undefined,
										})
									}
									className="flex items-center gap-2"
								>
									<Plus className="h-4 w-4 shrink-0" />
									<span>New Session</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}

				{/* New Session button - always visible when there are workspaces */}
				{workspaces.length > 0 && (
					<>
						<span className="text-muted-foreground shrink-0">/</span>
						<Button
							variant="ghost"
							size="sm"
							className="gap-1.5 text-muted-foreground shrink-0 tauri-no-drag"
							onClick={() =>
								showNewSession({
									workspaceId: selectedWorkspaceId ?? undefined,
								})
							}
						>
							<Plus className="h-4 w-4" />
							New Session
						</Button>
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
