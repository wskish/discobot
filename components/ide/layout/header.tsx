"use client";

import { SiGithub } from "@icons-pack/react-simple-icons";
import {
	Bot,
	Check,
	ChevronDown,
	GitBranch,
	HardDrive,
	Key,
	MessageSquare,
	PanelLeft,
	PanelLeftClose,
	Plus,
} from "lucide-react";
import * as React from "react";
import { CredentialsDialog } from "@/components/ide/credentials-dialog";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { OctobotLogo } from "@/components/ide/octobot-logo";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { isTauriEnv, WindowControls } from "@/components/ide/window-controls";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent, Workspace } from "@/lib/api-types";
import { useSessionContext } from "@/lib/contexts/session-context";
import { cn } from "@/lib/utils";

function getWorkspaceType(path: string): "github" | "git" | "local" {
	if (path.includes("github.com") || path.startsWith("git@github.com")) {
		return "github";
	}
	if (
		path.startsWith("git@") ||
		path.startsWith("git://") ||
		(path.startsWith("https://") && path.includes(".git"))
	) {
		return "git";
	}
	return "local";
}

function getWorkspaceDisplayName(path: string): string {
	const type = getWorkspaceType(path);
	if (type === "github") {
		const match = path.match(/github\.com[:/](.+?)(\.git)?$/);
		if (match) return match[1].replace(/\.git$/, "");
		return path;
	}
	if (type === "git") {
		return path
			.replace(/^(git@|git:\/\/|https?:\/\/)/, "")
			.replace(/\.git$/, "");
	}
	return path;
}

function WorkspaceIcon({
	path,
	className,
}: {
	path: string;
	className?: string;
}) {
	const type = getWorkspaceType(path);
	if (type === "github") return <SiGithub className={className} />;
	if (type === "git")
		return <GitBranch className={cn("text-orange-500", className)} />;
	return <HardDrive className={cn("text-blue-500", className)} />;
}

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
	const {
		workspaces,
		agentTypes,
		selectedSession,
		sessionAgent,
		sessionWorkspace,
		handleSessionSelect,
	} = useSessionContext();

	const [credentialsOpen, setCredentialsOpen] = React.useState(false);

	const getAgentIcons = (a: Agent) => {
		const agentType = agentTypes.find((t) => t.id === a.agentType);
		return agentType?.icons;
	};

	// Get sessions for current workspace (non-closed only)
	const workspaceSessions = React.useMemo(() => {
		if (!sessionWorkspace) return [];
		return sessionWorkspace.sessions.filter((s) => s.status !== "closed");
	}, [sessionWorkspace]);

	const hasSession = selectedSession || sessionWorkspace;

	// Handle workspace selection from breadcrumb dropdown
	const handleWorkspaceSelect = React.useCallback(
		(workspace: Workspace) => {
			// Find first non-closed session in this workspace
			const firstSession = workspace.sessions.find(
				(s) => s.status !== "closed",
			);
			if (firstSession) {
				handleSessionSelect(firstSession);
			}
		},
		[handleSessionSelect],
	);

	// Detect macOS for window control placement
	const [isMac, setIsMac] = React.useState(false);
	React.useEffect(() => {
		if (!isTauriEnv) return;
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
				{isTauriEnv && isMac && <WindowControls />}
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
										<WorkspaceIcon
											path={sessionWorkspace.path}
											className="h-4 w-4 shrink-0"
										/>
										<span className="truncate max-w-[150px]">
											{getWorkspaceDisplayName(sessionWorkspace.path)}
										</span>
										<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="w-64">
									{workspaces.map((ws) => {
										const isSelected = ws.id === sessionWorkspace.id;
										const nonClosedSessions = ws.sessions.filter(
											(s) => s.status !== "closed",
										);
										return (
											<DropdownMenuItem
												key={ws.id}
												onClick={() => handleWorkspaceSelect(ws)}
												className="flex items-center gap-2"
											>
												<WorkspaceIcon
													path={ws.path}
													className="h-4 w-4 shrink-0"
												/>
												<span className="truncate flex-1">
													{getWorkspaceDisplayName(ws.path)}
												</span>
												<span className="text-xs text-muted-foreground">
													{nonClosedSessions.length}
												</span>
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
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0 tauri-no-drag"
										>
											<MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
											<span className="truncate max-w-[200px] font-medium">
												{selectedSession.name}
											</span>
											<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="w-72">
										{workspaceSessions.length > 0 ? (
											workspaceSessions.map((session) => {
												const isSelected = session.id === selectedSession.id;
												return (
													<DropdownMenuItem
														key={session.id}
														onClick={() => handleSessionSelect(session)}
														className="flex items-center gap-2"
													>
														<MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
														<div className="flex-1 min-w-0">
															<div className="truncate font-medium">
																{session.name}
															</div>
															<div className="text-xs text-muted-foreground truncate">
																{session.timestamp}
															</div>
														</div>
														{isSelected && (
															<Check className="h-4 w-4 shrink-0 text-primary" />
														)}
													</DropdownMenuItem>
												);
											})
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
				{isTauriEnv && !isMac && <WindowControls />}
			</div>

			<CredentialsDialog
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
			/>
		</header>
	);
}
