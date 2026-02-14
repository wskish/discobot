import {
	Bot,
	ChevronDown,
	Container,
	FileDiff,
	FolderGit2,
	FolderOpen,
	Loader2,
	MessageSquare,
	Network,
	Plus,
	Sparkles,
	Terminal,
} from "lucide-react";
import { DiscobotLogo } from "@/components/ide/discobot-logo";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { WorkspaceDisplay } from "@/components/ide/workspace-display";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent, Icon, Workspace } from "@/lib/api-types";
import { openUrl } from "@/lib/tauri";

interface WelcomeHeaderProps {
	show: boolean;
	hasAgent: boolean;
	hasWorkspace: boolean;
	agentsCount: number;
	workspacesCount: number;
	onAddAgent?: () => void;
	onAddWorkspace?: (mode?: "git" | "local" | "generic") => void;
	onAddSampleWorkspace?: () => void;
	isCreatingSampleWorkspace?: boolean;
}

export function WelcomeHeader({
	show,
	hasAgent,
	hasWorkspace,
	agentsCount,
	workspacesCount,
	onAddAgent,
	onAddWorkspace,
	onAddSampleWorkspace,
	isCreatingSampleWorkspace = false,
}: WelcomeHeaderProps) {
	if (!show) return null;

	// Special onboarding UI when no agents exist
	if (agentsCount === 0) {
		return (
			<div className="flex flex-col items-center py-12 px-6 max-w-2xl mx-auto">
				<div className="text-center space-y-6">
					{/* Icon with gradient background */}
					<DiscobotLogo size={64} className="text-purple-500 mx-auto" />

					{/* Title and description */}
					<div className="space-y-3">
						<h2 className="text-2xl font-bold">Welcome to Discobot</h2>
						<div className="space-y-2 text-muted-foreground leading-relaxed">
							<p className="text-base">
								To get started, you'll need to register a coding agent.
							</p>
							<p className="text-sm">
								Coding agents are AI assistants that help you write code, debug
								issues, and build features. Discobot supports multiple agent
								types, each with different models, modes, and capabilities to
								match your workflow.
							</p>
						</div>
					</div>

					{/* Feature highlights */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-left max-w-2xl mx-auto mt-6">
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<Bot className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">
									Multiple Coding Agents
								</div>
								<div className="text-xs text-muted-foreground">
									Currently only Claude Code supported.{" "}
									<button
										type="button"
										onClick={() =>
											openUrl(
												"https://github.com/obot-platform/discobot/issues/new",
											)
										}
										className="underline hover:text-foreground transition-colors"
									>
										Open an issue
									</button>{" "}
									for OpenCode, Gemini CLI, or others you want supported next!
								</div>
							</div>
						</div>
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<MessageSquare className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">
									Session-Based Agent Selection
								</div>
								<div className="text-xs text-muted-foreground">
									Choose which coding agent to use for each session
								</div>
							</div>
						</div>
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<Container className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">
									Isolated Sandboxed Sessions
								</div>
								<div className="text-xs text-muted-foreground">
									Run parallel sessions in secure containers with full app
									debugging capabilities
								</div>
							</div>
						</div>
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<Terminal className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">Use Your Own IDE</div>
								<div className="text-xs text-muted-foreground">
									Launch remote IDE sessions directly into each sandbox
								</div>
							</div>
						</div>
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<Network className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">SSH into Sandboxes</div>
								<div className="text-xs text-muted-foreground">
									Direct SSH access to every sandbox environment
								</div>
							</div>
						</div>
						<div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
							<FileDiff className="h-5 w-5 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1">
								<div className="font-medium text-sm">
									Integrated Lightweight Tools
								</div>
								<div className="text-xs text-muted-foreground">
									Built-in terminal, diff viewer, and editor for quick edits
								</div>
							</div>
						</div>
					</div>

					{/* CTA button */}
					<div className="pt-4">
						<Button
							size="lg"
							onClick={onAddAgent}
							className="gap-2 shadow-lg shadow-primary/20"
						>
							<Plus className="h-5 w-5" />
							<span>Register Your First Agent</span>
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// Workspace onboarding when agent exists but no workspaces
	if (agentsCount > 0 && workspacesCount === 0) {
		return (
			<div className="flex flex-col items-center py-12 px-6 max-w-2xl mx-auto">
				<div className="text-center space-y-6">
					{/* Icon with gradient background */}
					<div className="relative mx-auto w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center">
						<FolderGit2 className="h-10 w-10 text-primary" />
					</div>

					{/* Title and description */}
					<div className="space-y-3">
						<h2 className="text-2xl font-bold">Create Your First Workspace</h2>
						<div className="space-y-2 text-muted-foreground leading-relaxed">
							<p className="text-base">
								A workspace is a coding environment where your agent works on
								projects.
							</p>
							<p className="text-sm">
								Each workspace can be a local folder or a git repository. The
								agent can read, write, and execute code within the workspace's
								isolated sandbox.
							</p>
						</div>
					</div>

					{/* Workspace options */}
					<div className="grid grid-cols-1 gap-3 text-left max-w-md mx-auto mt-6">
						<button
							type="button"
							onClick={() => onAddWorkspace?.("git")}
							className="flex items-start gap-3 p-4 rounded-lg bg-muted/30 border-2 border-transparent hover:border-primary/50 hover:bg-muted/50 transition-all text-left"
						>
							<FolderGit2 className="h-6 w-6 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1 flex-1">
								<div className="font-medium">Clone a Git Repository</div>
								<div className="text-sm text-muted-foreground">
									Clone an existing repository from GitHub, GitLab, or any Git
									URL
								</div>
							</div>
						</button>

						<button
							type="button"
							onClick={() => onAddWorkspace?.("local")}
							className="flex items-start gap-3 p-4 rounded-lg bg-muted/30 border-2 border-transparent hover:border-primary/50 hover:bg-muted/50 transition-all text-left"
						>
							<FolderOpen className="h-6 w-6 text-primary shrink-0 mt-0.5" />
							<div className="space-y-1 flex-1">
								<div className="font-medium">Use Existing Project on Disk</div>
								<div className="text-sm text-muted-foreground">
									Point to a local folder that contains your project
								</div>
							</div>
						</button>

						<button
							type="button"
							onClick={() => onAddSampleWorkspace?.()}
							disabled={isCreatingSampleWorkspace}
							className="flex items-start gap-3 p-4 rounded-lg bg-primary/10 border-2 border-primary/30 hover:border-primary/50 hover:bg-primary/15 transition-all text-left disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:border-primary/30 disabled:hover:bg-primary/10"
						>
							{isCreatingSampleWorkspace ? (
								<Loader2 className="h-6 w-6 text-primary shrink-0 mt-0.5 animate-spin" />
							) : (
								<Sparkles className="h-6 w-6 text-primary shrink-0 mt-0.5" />
							)}
							<div className="space-y-1 flex-1">
								<div className="font-medium">
									{isCreatingSampleWorkspace
										? "Creating Sample Project..."
										: "Try a Sample Project"}
								</div>
								<div className="text-sm text-muted-foreground">
									{isCreatingSampleWorkspace
										? "Cloning repository and setting up workspace"
										: "Quick start with a pre-configured demo project"}
								</div>
							</div>
						</button>
					</div>

					{/* Info note */}
					<div className="pt-4">
						<p className="text-xs text-muted-foreground">
							Sessions run in isolated sandboxes — files on disk won't be
							modified until you commit, so you can safely try out existing
							projects
						</p>
					</div>
				</div>
			</div>
		);
	}

	// Standard UI when agents exist
	let title = "Start a new session";
	let message =
		"Describe what you want to work on and I'll help you get started.";

	// Priority: agent first, then workspace
	if (!hasAgent) {
		title = "Select an agent";
		message = "Choose an agent to get started.";
	} else if (!hasWorkspace) {
		title = "Create a workspace";
		message = "Select a workspace to get started.";
	}

	return (
		<div className="flex flex-col items-center py-6">
			<div className="text-center space-y-2">
				<MessageSquare className="h-12 w-12 mx-auto text-muted-foreground/50" />
				<h2 className="text-xl font-semibold">{title}</h2>
				<p className="text-muted-foreground text-sm">{message}</p>
			</div>
		</div>
	);
}

interface WelcomeSelectorsProps {
	show: boolean;
	agents: Agent[];
	workspaces: Workspace[];
	selectedAgent: Agent | undefined;
	selectedWorkspace: Workspace | undefined;
	getAgentIcons: (agent: Agent) => Icon[] | undefined;
	getAgentName: (agent: Agent) => string;
	onSelectAgent: (id: string) => void;
	onSelectWorkspace: (id: string) => void;
	onAddAgent: () => void;
	onAddWorkspace: () => void;
}

export function WelcomeSelectors({
	show,
	agents,
	workspaces,
	selectedAgent,
	selectedWorkspace,
	getAgentIcons,
	getAgentName,
	onSelectAgent,
	onSelectWorkspace,
	onAddAgent,
	onAddWorkspace,
}: WelcomeSelectorsProps) {
	if (!show) return null;

	// Don't show selectors when there are no agents or workspaces (onboarding screen handles this)
	if (agents.length === 0 || workspaces.length === 0) return null;

	return (
		<div className="flex flex-col items-center gap-3 py-4">
			<div className="flex items-center gap-2">
				<span className="text-sm text-muted-foreground w-20 text-right">
					Agent:
				</span>
				{agents.length === 0 ? (
					<Button
						variant="outline"
						size="sm"
						className="gap-2 min-w-[200px] bg-transparent"
						onClick={onAddAgent}
					>
						<Plus className="h-4 w-4" />
						<span>Add Agent</span>
					</Button>
				) : (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								className="gap-2 min-w-[200px] justify-between bg-transparent"
							>
								{selectedAgent ? (
									<>
										<div className="flex items-center gap-2 truncate">
											{getAgentIcons(selectedAgent) ? (
												<IconRenderer
													icons={getAgentIcons(selectedAgent)}
													size={16}
													className="shrink-0"
												/>
											) : (
												<Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
											)}
											<span className="truncate">
												{getAgentName(selectedAgent)}
											</span>
										</div>
										<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
									</>
								) : (
									<>
										<span className="text-muted-foreground">Select agent</span>
										<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
									</>
								)}
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="center" className="w-[250px]">
							{agents.map((agent) => (
								<DropdownMenuItem
									key={agent.id}
									onClick={() => onSelectAgent(agent.id)}
									className="gap-2"
								>
									{getAgentIcons(agent) ? (
										<IconRenderer
											icons={getAgentIcons(agent)}
											size={16}
											className="shrink-0"
										/>
									) : (
										<Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
									)}
									<span className="truncate flex-1">{getAgentName(agent)}</span>
								</DropdownMenuItem>
							))}
							<DropdownMenuSeparator />
							<DropdownMenuItem onClick={onAddAgent} className="gap-2">
								<Plus className="h-4 w-4" />
								<span>Add Agent</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>

			<div className="flex items-center gap-2">
				<span className="text-sm text-muted-foreground w-20 text-right">
					Workspace:
				</span>
				{workspaces.length === 0 ? (
					<Button
						variant="outline"
						size="sm"
						className="gap-2 min-w-[200px] bg-transparent"
						onClick={onAddWorkspace}
					>
						<Plus className="h-4 w-4" />
						<span>Add Workspace</span>
					</Button>
				) : (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								className="gap-2 min-w-[200px] justify-between bg-transparent"
							>
								{selectedWorkspace ? (
									<>
										<WorkspaceDisplay
											workspace={selectedWorkspace}
											iconSize={16}
											iconClassName="h-4 w-4"
											showTooltip={false}
										/>
										<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
									</>
								) : (
									<>
										<span className="text-muted-foreground">
											Select workspace
										</span>
										<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
									</>
								)}
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="center" className="w-[250px]">
							{workspaces.map((ws) => (
								<DropdownMenuItem
									key={ws.id}
									onClick={() => onSelectWorkspace(ws.id)}
									className="gap-2"
								>
									<WorkspaceDisplay
										workspace={ws}
										iconSize={16}
										iconClassName="h-4 w-4"
										showTooltip={false}
									/>
								</DropdownMenuItem>
							))}
							{workspaces.length > 0 && <DropdownMenuSeparator />}
							<DropdownMenuItem onClick={onAddWorkspace} className="gap-2">
								<Plus className="h-4 w-4" />
								<span>Add Workspace</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		</div>
	);
}
