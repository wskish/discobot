"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Bot, ChevronDown, MessageSquare, Plus } from "lucide-react";
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
import { cn } from "@/lib/utils";

interface WelcomeHeaderProps {
	show: boolean;
}

export function WelcomeHeader({ show }: WelcomeHeaderProps) {
	return (
		<AnimatePresence>
			{show && (
				<motion.div
					initial={{ opacity: 0, height: 0 }}
					animate={{ opacity: 1, height: "auto" }}
					exit={{ opacity: 0, height: 0 }}
					transition={{ duration: 0.3, ease: "easeInOut" }}
					className="flex flex-col items-center py-6 overflow-hidden"
				>
					<div className="text-center space-y-2">
						<MessageSquare className="h-12 w-12 mx-auto text-muted-foreground/50" />
						<h2 className="text-xl font-semibold">Start a new session</h2>
						<p className="text-muted-foreground text-sm">
							Describe what you want to work on and I'll help you get started.
						</p>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

interface WelcomeSelectorsProps {
	show: boolean;
	agents: Agent[];
	workspaces: Workspace[];
	selectedAgent: Agent | undefined;
	selectedWorkspace: Workspace | undefined;
	isShimmering: boolean;
	getAgentIcons: (agent: Agent) => Icon[] | undefined;
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
	isShimmering,
	getAgentIcons,
	onSelectAgent,
	onSelectWorkspace,
	onAddAgent,
	onAddWorkspace,
}: WelcomeSelectorsProps) {
	return (
		<AnimatePresence>
			{show && (
				<motion.div
					initial={{ opacity: 0, height: 0 }}
					animate={{ opacity: 1, height: "auto" }}
					exit={{ opacity: 0, height: 0 }}
					transition={{ duration: 0.3, ease: "easeInOut" }}
					className="flex flex-col items-center gap-3 py-4 overflow-hidden"
				>
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground w-20 text-right">
							Agent:
						</span>
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
												<span className="truncate">{selectedAgent.name}</span>
											</div>
											<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
										</>
									) : (
										<>
											<span className="text-muted-foreground">
												Select agent
											</span>
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
										<span className="truncate flex-1">{agent.name}</span>
									</DropdownMenuItem>
								))}
								{agents.length > 0 && <DropdownMenuSeparator />}
								<DropdownMenuItem onClick={onAddAgent} className="gap-2">
									<Plus className="h-4 w-4" />
									<span>Add Agent</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground w-20 text-right">
							Workspace:
						</span>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className={cn(
										"gap-2 min-w-[200px] justify-between bg-transparent transition-all",
										isShimmering && "animate-pulse ring-2 ring-primary/50",
									)}
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
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
}
