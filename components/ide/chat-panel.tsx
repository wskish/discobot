"use client";

import {
	Bot,
	ChevronDown,
	Copy,
	GitBranch,
	Github,
	HardDrive,
	MessageSquare,
	Play,
	Plus,
	RefreshCcw,
	Terminal,
} from "lucide-react";
import * as React from "react";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
	MessageRoleProvider,
} from "@/components/ai-elements/message";
import {
	Input,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputToolbar,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
	if (type === "github") return <Github className={className} />;
	if (type === "git")
		return <GitBranch className={cn("text-orange-500", className)} />;
	return <HardDrive className={cn("text-blue-500", className)} />;
}

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	turn: number;
}

interface ChatPanelProps {
	initialMessages?: ChatMessage[];
	onToggleTerminal: () => void;
	showTerminal: boolean;
	className?: string;
	hideHeader?: boolean;
	centered?: boolean;
	onFirstMessage?: (
		message: string,
		workspaceId: string,
		agentId: string,
		modeId?: string,
		modelId?: string,
	) => void;
	workspaces?: Workspace[];
	selectedWorkspaceId?: string | null;
	onAddWorkspace?: () => void;
	workspaceSelectTrigger?: number;
	agents?: Agent[];
	selectedAgentId?: string | null;
	onAddAgent?: () => void;
	agentTypes?: SupportedAgentType[];
	sessionAgent?: Agent | null;
	sessionWorkspace?: Workspace | null;
}

export function ChatPanel({
	initialMessages = [],
	onToggleTerminal,
	showTerminal,
	className,
	hideHeader,
	centered,
	onFirstMessage,
	workspaces = [],
	selectedWorkspaceId,
	onAddWorkspace,
	workspaceSelectTrigger,
	agents = [],
	selectedAgentId,
	onAddAgent,
	agentTypes = [],
	sessionAgent,
	sessionWorkspace,
}: ChatPanelProps) {
	const [input, setInput] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [localSelectedWorkspaceId, setLocalSelectedWorkspaceId] =
		React.useState<string | null>(
			selectedWorkspaceId || (workspaces.length > 0 ? workspaces[0].id : null),
		);
	const [localSelectedAgentId, setLocalSelectedAgentId] = React.useState<
		string | null
	>(selectedAgentId || (agents.length > 0 ? agents[0].id : null));
	const [selectedModeId, setSelectedModeId] = React.useState<string | null>(
		null,
	);
	const [selectedModelId, setSelectedModelId] = React.useState<string | null>(
		null,
	);
	const [isShimmering, setIsShimmering] = React.useState(false);

	React.useEffect(() => {
		if (selectedWorkspaceId) {
			setLocalSelectedWorkspaceId(selectedWorkspaceId);
		}
	}, [selectedWorkspaceId]);

	React.useEffect(() => {
		if (selectedAgentId) {
			setLocalSelectedAgentId(selectedAgentId);
		}
	}, [selectedAgentId]);

	React.useEffect(() => {
		if (workspaceSelectTrigger && workspaceSelectTrigger > 0) {
			setIsShimmering(true);
			const timeout = setTimeout(() => setIsShimmering(false), 600);
			return () => clearTimeout(timeout);
		}
	}, [workspaceSelectTrigger]);

	const selectedWorkspace = workspaces.find(
		(ws) => ws.id === localSelectedWorkspaceId,
	);
	const selectedAgent = agents.find((a) => a.id === localSelectedAgentId);

	const selectedAgentType = React.useMemo(() => {
		if (!selectedAgent) return null;
		return agentTypes.find((t) => t.id === selectedAgent.agentType);
	}, [selectedAgent, agentTypes]);

	React.useEffect(() => {
		if (selectedAgentType) {
			setSelectedModeId(selectedAgentType.modes?.[0]?.id || null);
			setSelectedModelId(selectedAgentType.models?.[0]?.id || null);
		} else {
			setSelectedModeId(null);
			setSelectedModelId(null);
		}
	}, [selectedAgentType]);

	const selectedMode = selectedAgentType?.modes?.find(
		(m) => m.id === selectedModeId,
	);
	const selectedModel = selectedAgentType?.models?.find(
		(m) => m.id === selectedModelId,
	);

	const [messages, setMessages] = React.useState<InternalMessage[]>(() =>
		initialMessages.map((m) => ({
			id: m.id,
			role: m.role,
			parts: [{ type: "text" as const, text: m.content }],
			createdAt: new Date(),
		})),
	);

	React.useEffect(() => {
		setMessages(
			initialMessages.map((m) => ({
				id: m.id,
				role: m.role,
				parts: [{ type: "text", text: m.content }],
				createdAt: new Date(),
			})),
		);
	}, [initialMessages]);

	const groupedByTurn = React.useMemo(() => {
		const groups: { turn: number; messages: InternalMessage[] }[] = [];
		let currentTurn = 1;
		let currentGroup: InternalMessage[] = [];

		messages.forEach((msg) => {
			currentGroup.push(msg);
			if (msg.role === "assistant") {
				groups.push({ turn: currentTurn, messages: currentGroup });
				currentGroup = [];
				currentTurn++;
			}
		});

		if (currentGroup.length > 0) {
			groups.push({ turn: currentTurn, messages: currentGroup });
		}

		return groups;
	}, [messages]);

	const handleSubmit = async () => {
		if (!input.trim() || isLoading) return;

		const messageText = input;

		if (
			messages.length === 0 &&
			onFirstMessage &&
			localSelectedWorkspaceId &&
			localSelectedAgentId
		) {
			onFirstMessage(
				messageText,
				localSelectedWorkspaceId,
				localSelectedAgentId,
				selectedModeId || undefined,
				selectedModelId || undefined,
			);
		}

		const userMessage: InternalMessage = {
			id: `msg-${Date.now()}`,
			role: "user",
			parts: [{ type: "text", text: messageText }],
			createdAt: new Date(),
		};

		setMessages((prev) => [...prev, userMessage]);
		setInput("");
		setIsLoading(true);

		await new Promise((resolve) => setTimeout(resolve, 1000));

		const assistantMessage: InternalMessage = {
			id: `msg-${Date.now() + 1}`,
			role: "assistant",
			parts: [
				{
					type: "text",
					text: `I understand you're asking about: "${messageText}"\n\nThis is a simulated response. In production, this would connect to your AI backend via the API route.`,
				},
			],
			createdAt: new Date(),
		};

		setMessages((prev) => [...prev, assistantMessage]);
		setIsLoading(false);
	};

	const handleCopy = (text: string) => {
		navigator.clipboard.writeText(text);
	};

	const handleRegenerate = () => {
		console.log("Regenerate last response");
	};

	const status = isLoading ? "streaming" : "ready";

	const getAgentIcons = (agent: Agent) => {
		const agentType = agentTypes.find((t) => t.id === agent.agentType);
		return agentType?.icons;
	};

	const ModelModeSelector = () => {
		if (!selectedAgentType || !selectedAgent) return null;

		const hasModels =
			selectedAgentType.models && selectedAgentType.models.length > 0;
		const hasModes =
			selectedAgentType.modes && selectedAgentType.modes.length > 0;

		if (!hasModels && !hasModes) return null;

		const agentIcons = getAgentIcons(selectedAgent);

		return (
			<>
				{hasModels && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
							>
								{agentIcons ? (
									<IconRenderer
										icons={agentIcons}
										size={14}
										className="shrink-0"
									/>
								) : (
									<Bot className="h-3.5 w-3.5 shrink-0" />
								)}
								<span>{selectedModel?.name || "Model"}</span>
								<ChevronDown className="h-3 w-3 opacity-50" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-[220px]">
							{selectedAgentType.models?.map((model) => (
								<DropdownMenuItem
									key={model.id}
									onClick={() => setSelectedModelId(model.id)}
									className={cn(
										"flex-col items-start gap-0.5",
										model.id === selectedModelId && "bg-accent",
									)}
								>
									<span className="font-medium">{model.name}</span>
									{model.provider && (
										<span className="text-xs text-muted-foreground">
											{model.provider}
										</span>
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				)}

				{hasModes && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
							>
								<Play className="h-3.5 w-3.5 shrink-0" />
								<span>{selectedMode?.name || "Mode"}</span>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-[200px]">
							{selectedAgentType.modes?.map((mode) => (
								<DropdownMenuItem
									key={mode.id}
									onClick={() => setSelectedModeId(mode.id)}
									className={cn(
										"flex-col items-start gap-0.5",
										mode.id === selectedModeId && "bg-accent",
									)}
								>
									<span className="font-medium">{mode.name}</span>
									{mode.description && (
										<span className="text-xs text-muted-foreground">
											{mode.description}
										</span>
									)}
								</DropdownMenuItem>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</>
		);
	};

	const getSessionAgentIcons = () => {
		if (!sessionAgent) return null;
		const agentType = agentTypes.find((t) => t.id === sessionAgent.agentType);
		return agentType?.icons;
	};

	if (centered) {
		return (
			<div
				className={cn(
					"flex flex-col items-center justify-center h-full bg-background p-8",
					className,
				)}
			>
				<div className="w-full max-w-2xl space-y-6">
					<div className="text-center space-y-2">
						<MessageSquare className="h-12 w-12 mx-auto text-muted-foreground/50" />
						<h2 className="text-xl font-semibold">Start a new session</h2>
						<p className="text-muted-foreground text-sm">
							Describe what you want to work on and I'll help you get started.
						</p>
					</div>

					<div className="flex flex-col items-center gap-3">
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
											onClick={() => setLocalSelectedAgentId(agent.id)}
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
												<div className="flex items-center gap-2 truncate">
													<WorkspaceIcon
														path={selectedWorkspace.path}
														className="h-4 w-4 shrink-0"
													/>
													<span className="truncate">
														{getWorkspaceDisplayName(selectedWorkspace.path)}
													</span>
												</div>
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
											onClick={() => setLocalSelectedWorkspaceId(ws.id)}
											className="gap-2"
										>
											<WorkspaceIcon
												path={ws.path}
												className="h-4 w-4 shrink-0"
											/>
											<span className="truncate">
												{getWorkspaceDisplayName(ws.path)}
											</span>
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
					</div>

					<Input
						onSubmit={handleSubmit}
						value={input}
						onChange={setInput}
						status={status}
						className="max-w-full"
					>
						<PromptInputTextarea
							placeholder="What would you like to work on?"
							className="min-h-[80px] text-base"
						/>
						<PromptInputToolbar>
							<PromptInputTools>
								<ModelModeSelector />
							</PromptInputTools>
							<PromptInputSubmit
								status={status}
								disabled={!localSelectedWorkspaceId || !localSelectedAgentId}
							/>
						</PromptInputToolbar>
					</Input>
				</div>
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{!hideHeader && (
				<div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
					<div className="flex items-center gap-3">
						{sessionAgent && (
							<div className="flex items-center gap-1.5 text-sm">
								{(() => {
									const icons = getSessionAgentIcons();
									return icons ? (
										<IconRenderer
											icons={icons}
											size={16}
											className="shrink-0"
										/>
									) : (
										<Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
									);
								})()}
								<span className="font-medium">{sessionAgent.name}</span>
							</div>
						)}
						{sessionAgent && sessionWorkspace && (
							<span className="text-muted-foreground">/</span>
						)}
						{sessionWorkspace && (
							<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
								<WorkspaceIcon
									path={sessionWorkspace.path}
									className="h-4 w-4 shrink-0"
								/>
								<span>{getWorkspaceDisplayName(sessionWorkspace.path)}</span>
							</div>
						)}
						{!sessionAgent && !sessionWorkspace && (
							<h2 className="font-medium text-sm">Chat</h2>
						)}
					</div>
					<Button
						variant={showTerminal ? "default" : "ghost"}
						size="sm"
						onClick={onToggleTerminal}
						className="gap-2"
					>
						<Terminal className="h-4 w-4" />
						<span className="hidden sm:inline">Terminal</span>
					</Button>
				</div>
			)}

			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="p-4">
					{groupedByTurn.length === 0 ? (
						<ConversationEmptyState
							icon={<MessageSquare className="size-12 opacity-50" />}
							title="Start a conversation"
							description="Type a message below to begin chatting with the AI assistant."
						/>
					) : (
						<div className="space-y-6">
							{groupedByTurn.map((group) => (
								<div key={`turn-${group.turn}`} className="relative">
									<div className="flex items-center gap-2 mb-3">
										<span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded">
											Turn {group.turn}
										</span>
										<div className="flex-1 h-px bg-border" />
									</div>

									<div className="space-y-3 pl-3 border-l-2 border-border">
										{group.messages.map((message, messageIdx) => (
											<MessageRoleProvider key={message.id} role={message.role}>
												<Message from={message.role}>
													<MessageContent>
														<div className="text-xs font-medium text-muted-foreground mb-1">
															{message.role === "user" ? "You" : "Assistant"}
														</div>
														{message.parts.map((part, i) => {
															if (part.type === "text") {
																return (
																	<MessageResponse key={`${message.id}-${i}`}>
																		{part.text}
																	</MessageResponse>
																);
															}
															return null;
														})}
														{message.role === "assistant" &&
															messageIdx === group.messages.length - 1 && (
																<MessageActions>
																	<MessageAction
																		label="Retry"
																		tooltip="Regenerate response"
																		onClick={handleRegenerate}
																	>
																		<RefreshCcw className="size-3" />
																	</MessageAction>
																	<MessageAction
																		label="Copy"
																		tooltip="Copy to clipboard"
																		onClick={() => {
																			const textPart = message.parts.find(
																				(p) => p.type === "text",
																			);
																			if (textPart && "text" in textPart) {
																				handleCopy(textPart.text);
																			}
																		}}
																	>
																		<Copy className="size-3" />
																	</MessageAction>
																</MessageActions>
															)}
													</MessageContent>
												</Message>
											</MessageRoleProvider>
										))}
									</div>
								</div>
							))}
						</div>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="p-4 border-t border-border shrink-0">
				<Input
					onSubmit={handleSubmit}
					value={input}
					onChange={setInput}
					status={status}
				>
					<PromptInputTextarea
						placeholder="Type a message..."
						className="min-h-[60px]"
					/>
					<PromptInputToolbar>
						<PromptInputTools>
							<ModelModeSelector />
						</PromptInputTools>
						<PromptInputSubmit status={status} />
					</PromptInputToolbar>
				</Input>
			</div>
		</div>
	);
}

interface InternalMessage {
	id: string;
	role: "user" | "assistant";
	parts: { type: "text"; text: string }[];
	createdAt: Date;
}
