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
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {
	Agent,
	Session,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
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
	// Breadcrumb data
	workspaces?: Workspace[];
	selectedSession?: Session | null;
	sessionAgent?: Agent | null;
	sessionWorkspace?: Workspace | null;
	agentTypes?: SupportedAgentType[];
	// Breadcrumb actions
	onWorkspaceSelect?: (workspace: Workspace) => void;
	onSessionSelect?: (session: Session) => void;
	// Credentials dialog props
	credentialsOpen?: boolean;
	onCredentialsOpenChange?: (open: boolean) => void;
	credentialsInitialProviderId?: string | null;
}

export function Header({
	leftSidebarOpen,
	onToggleSidebar,
	onNewSession,
	workspaces = [],
	selectedSession,
	sessionAgent,
	sessionWorkspace,
	agentTypes = [],
	onWorkspaceSelect,
	onSessionSelect,
	credentialsOpen: externalCredentialsOpen,
	onCredentialsOpenChange: externalOnCredentialsOpenChange,
	credentialsInitialProviderId,
}: HeaderProps) {
	const [internalCredentialsOpen, setInternalCredentialsOpen] =
		React.useState(false);

	// Use external state if provided, otherwise use internal state
	const credentialsOpen = externalCredentialsOpen ?? internalCredentialsOpen;
	const setCredentialsOpen =
		externalOnCredentialsOpenChange ?? setInternalCredentialsOpen;

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

	return (
		<header className="h-12 border-b border-border flex items-center justify-between px-4">
			<div className="flex items-center gap-2 min-w-0">
				<Button variant="ghost" size="icon" onClick={onToggleSidebar}>
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
					className="gap-1.5 text-muted-foreground shrink-0"
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
										className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0"
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
												onClick={() => onWorkspaceSelect?.(ws)}
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
											className="flex items-center gap-1.5 text-sm px-2 py-1 rounded-md hover:bg-accent transition-colors min-w-0"
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
														onClick={() => onSessionSelect?.(session)}
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
			<div className="flex items-center gap-1 shrink-0">
				<Button
					variant="ghost"
					size="icon"
					onClick={() => setCredentialsOpen(true)}
					title="API Credentials"
				>
					<Key className="h-4 w-4" />
					<span className="sr-only">API Credentials</span>
				</Button>
				<ThemeToggle />
			</div>

			<CredentialsDialog
				open={credentialsOpen}
				onOpenChange={setCredentialsOpen}
				initialProviderId={credentialsInitialProviderId}
			/>
		</header>
	);
}
