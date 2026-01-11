"use client";

import { SiGithub } from "@icons-pack/react-simple-icons";
import {
	Bot,
	GitBranch,
	HardDrive,
	Key,
	PanelLeft,
	PanelLeftClose,
	Plus,
} from "lucide-react";
import * as React from "react";
import { CredentialsDialog } from "@/components/ide/credentials-dialog";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { Button } from "@/components/ui/button";
import type { Agent, SupportedAgentType, Workspace } from "@/lib/api-types";
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
	// Session breadcrumb props
	sessionAgent?: Agent | null;
	sessionWorkspace?: Workspace | null;
	agentTypes?: SupportedAgentType[];
	// Credentials dialog props
	credentialsOpen?: boolean;
	onCredentialsOpenChange?: (open: boolean) => void;
	credentialsInitialProviderId?: string | null;
}

export function Header({
	leftSidebarOpen,
	onToggleSidebar,
	onNewSession,
	sessionAgent,
	sessionWorkspace,
	agentTypes = [],
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

	const hasSession = sessionAgent || sessionWorkspace;

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
				<span className="font-semibold shrink-0">IDE Chat</span>
				<Button
					variant="ghost"
					size="sm"
					className="gap-1.5 text-muted-foreground shrink-0"
					onClick={onNewSession}
				>
					<Plus className="h-4 w-4" />
					New Session
				</Button>

				{/* Session breadcrumb */}
				{hasSession && (
					<>
						<span className="text-muted-foreground shrink-0">/</span>
						<div className="flex items-center gap-1.5 text-sm min-w-0">
							{sessionAgent && (
								<div className="flex items-center gap-1.5">
									{getAgentIcons(sessionAgent) ? (
										<IconRenderer
											icons={getAgentIcons(sessionAgent)}
											size={16}
											className="shrink-0"
										/>
									) : (
										<Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
									)}
									<span className="font-medium truncate">
										{sessionAgent.name}
									</span>
								</div>
							)}
							{sessionAgent && sessionWorkspace && (
								<span className="text-muted-foreground shrink-0">/</span>
							)}
							{sessionWorkspace && (
								<div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
									<WorkspaceIcon
										path={sessionWorkspace.path}
										className="h-4 w-4 shrink-0"
									/>
									<span className="truncate">
										{getWorkspaceDisplayName(sessionWorkspace.path)}
									</span>
								</div>
							)}
						</div>
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
