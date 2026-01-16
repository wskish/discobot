"use client";

import { useChat } from "@ai-sdk/react";
import { SiGithub } from "@icons-pack/react-simple-icons";
import { DefaultChatTransport, generateId, type UIMessage } from "ai";
import {
	AlertCircle,
	Bot,
	CheckCircle,
	ChevronDown,
	Copy,
	GitBranch,
	HardDrive,
	Loader2,
	MessageSquare,
	Play,
	Plus,
	RefreshCcw,
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
	PromptInputAttachment,
	PromptInputAttachmentsPreview,
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
import { getApiBase } from "@/lib/api-config";
import type { Agent, SessionStatus } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useMessages } from "@/lib/hooks/use-messages";
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

type ChatMode = "welcome" | "conversation";

// Helper to extract text content from AI SDK message parts
function getMessageText(message: UIMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
}

interface ChatPanelProps {
	className?: string;
}

// Map session status to human-readable text and icons
function getStatusDisplay(status: SessionStatus): {
	text: string;
	icon: React.ReactNode;
	isLoading: boolean;
} {
	switch (status) {
		case "initializing":
			return {
				text: "Initializing session...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "cloning":
			return {
				text: "Cloning repository...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "creating_sandbox":
			return {
				text: "Creating sandbox...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "starting_agent":
			return {
				text: "Starting agent...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "running":
			return {
				text: "Ready",
				icon: <CheckCircle className="h-4 w-4 text-green-500" />,
				isLoading: false,
			};
		case "error":
			return {
				text: "Error",
				icon: <AlertCircle className="h-4 w-4 text-destructive" />,
				isLoading: false,
			};
		case "closed":
			return {
				text: "Closed",
				icon: <CheckCircle className="h-4 w-4 text-muted-foreground" />,
				isLoading: false,
			};
		case "removing":
			return {
				text: "Removing session...",
				icon: <Loader2 className="h-4 w-4 animate-spin text-red-500" />,
				isLoading: true,
			};
		default:
			return {
				text: String(status),
				icon: null,
				isLoading: false,
			};
	}
}

export function ChatPanel({ className }: ChatPanelProps) {
	// Get data from context
	const session = useSessionContext();
	const dialogs = useDialogContext();

	// Destructure for convenience
	const {
		workspaces,
		agents,
		agentTypes,
		selectedSessionId,
		selectedSession,
		sessionAgent,
		sessionWorkspace,
		preselectedWorkspaceId,
		selectedAgentId,
		workspaceSelectTrigger,
		handleSessionCreated,
	} = session;

	// For new chats, generate a client-side session ID
	// This is generated once at mount and reset when a session is selected
	const [pendingSessionId, setPendingSessionId] = React.useState<string | null>(
		() => (selectedSessionId ? null : generateId()),
	);

	// Reset pending ID when session changes
	React.useEffect(() => {
		if (selectedSessionId) {
			// Existing session selected, clear pending ID
			setPendingSessionId(null);
		} else if (!pendingSessionId) {
			// No session and no pending ID, generate one
			setPendingSessionId(generateId());
		}
	}, [selectedSessionId, pendingSessionId]);

	// The effective chat ID: prefer existing session, fall back to pending
	const chatId = selectedSessionId || pendingSessionId;

	const [localSelectedWorkspaceId, setLocalSelectedWorkspaceId] =
		React.useState<string | null>(
			preselectedWorkspaceId ||
				(workspaces.length > 0 ? workspaces[0].id : null),
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

	// Manage input state locally
	const [input, setInput] = React.useState("");

	// Fetch existing messages when a session is selected
	// Use selectedSessionId directly (not derived selectedSession) to avoid stale cache issues
	const { messages: existingMessages } = useMessages(selectedSessionId);

	// Use refs to store the latest selection values for use in fetch
	// This ensures sendMessage always uses current values even if useChat caches the transport
	const selectionRef = React.useRef({
		workspaceId: localSelectedWorkspaceId,
		agentId: localSelectedAgentId,
		sessionId: selectedSessionId,
	});

	// Keep refs in sync with state
	React.useEffect(() => {
		selectionRef.current = {
			workspaceId: localSelectedWorkspaceId,
			agentId: localSelectedAgentId,
			sessionId: selectedSessionId,
		};
	}, [localSelectedWorkspaceId, localSelectedAgentId, selectedSessionId]);

	// Create transport with custom fetch that always uses latest selection values
	const transport = React.useMemo(
		() =>
			new DefaultChatTransport({
				api: `${getApiBase()}/chat`,
				// Use custom fetch to inject latest workspace/agent IDs from ref
				fetch: async (url, options) => {
					const { sessionId, workspaceId, agentId } = selectionRef.current;

					// Only modify body for new sessions (no existing session)
					if (!sessionId && options?.body) {
						const body = JSON.parse(options.body as string);
						body.workspaceId = workspaceId;
						body.agentId = agentId;
						return fetch(url, {
							...options,
							body: JSON.stringify(body),
						});
					}

					return fetch(url, options);
				},
			}),
		[], // No dependencies - we use ref for dynamic values
	);

	// Use AI SDK's useChat hook
	const {
		messages,
		setMessages,
		sendMessage,
		status: chatStatus,
		error: chatError,
	} = useChat({
		transport,
		// Use the effective chat ID (existing session or pending)
		id: chatId ?? undefined,
		// Load existing messages when session is selected (UIMessage format from container)
		messages: existingMessages.length > 0 ? existingMessages : undefined,
		// Handle stream errors
		onError: (error) => {
			console.error("Chat stream error:", error);
		},
	});

	// Sync existingMessages to useChat state when they load
	// This is needed because the messages prop only sets initial state
	React.useEffect(() => {
		if (existingMessages.length > 0) {
			setMessages(existingMessages);
		}
	}, [existingMessages, setMessages]);

	// Derive loading state from chat status
	const isLoading = chatStatus === "streaming" || chatStatus === "submitted";
	const hasError = chatStatus === "error";

	// Determine mode based on whether we have messages or a session
	// Use truthiness check since props may be undefined when not passed
	// Include selectedSessionId to handle cases where the session object hasn't loaded yet
	const hasSession =
		!!sessionAgent || !!sessionWorkspace || !!selectedSessionId;

	// Mode is "conversation" if we have a session or messages
	const mode: ChatMode =
		hasSession || messages.length > 0 ? "conversation" : "welcome";

	React.useEffect(() => {
		if (preselectedWorkspaceId) {
			setLocalSelectedWorkspaceId(preselectedWorkspaceId);
		}
	}, [preselectedWorkspaceId]);

	React.useEffect(() => {
		if (selectedAgentId) {
			setLocalSelectedAgentId(selectedAgentId);
		}
	}, [selectedAgentId]);

	// Auto-select first workspace when workspaces become available and nothing is selected
	React.useEffect(() => {
		// Only auto-select if nothing is currently selected or selected workspace doesn't exist
		const currentWorkspaceExists = workspaces.some(
			(ws) => ws.id === localSelectedWorkspaceId,
		);
		if (!localSelectedWorkspaceId || !currentWorkspaceExists) {
			const workspaceToSelect = workspaces[0];
			if (workspaceToSelect) {
				setLocalSelectedWorkspaceId(workspaceToSelect.id);
			}
		}
	}, [workspaces, localSelectedWorkspaceId]);

	// Auto-select default agent when agents become available and nothing is selected
	React.useEffect(() => {
		// Only auto-select if nothing is currently selected or selected agent doesn't exist
		const currentAgentExists = agents.some(
			(a) => a.id === localSelectedAgentId,
		);
		if (!localSelectedAgentId || !currentAgentExists) {
			// Prefer the default agent, otherwise use the first one
			const defaultAgent = agents.find((a) => a.isDefault);
			const agentToSelect = defaultAgent || agents[0];
			if (agentToSelect) {
				setLocalSelectedAgentId(agentToSelect.id);
			}
		}
	}, [agents, localSelectedAgentId]);

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

	// Group messages by turn (user + assistant pair)
	const groupedByTurn = React.useMemo(() => {
		const groups: { turn: number; messages: typeof messages }[] = [];
		let currentTurn = 1;
		let currentGroup: typeof messages = [];

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

	// Handle form submission
	const handleSubmit = async (
		message: {
			text?: string;
			files?:
				| FileList
				| { type: "file"; filename: string; mediaType: string; url: string }[];
		},
		e: React.FormEvent,
	) => {
		e.preventDefault();
		const messageText = message.text || input;
		if (!messageText.trim() || isLoading) return;

		// Validate selections for new sessions
		if (
			!selectedSessionId &&
			(!localSelectedWorkspaceId || !localSelectedAgentId)
		) {
			return;
		}

		// Track if this is a new session so we can notify parent after success
		const isNewSession = !selectedSessionId && pendingSessionId;

		// Clear input and send message
		setInput("");

		try {
			await sendMessage({ text: messageText });

			// For new chats, notify parent about the session ID AFTER the POST succeeds
			// This ensures the session exists on the server before the client tries to use it
			if (isNewSession) {
				handleSessionCreated(pendingSessionId);
			}
		} catch (err) {
			console.error("Failed to send message:", err);
			// Restore input on error
			setInput(messageText);
		}
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

	// Shared Model/Mode selector component
	const ModelModeSelector = () => {
		const activeAgent = mode === "welcome" ? selectedAgent : sessionAgent;
		const activeAgentType = activeAgent
			? agentTypes.find((t) => t.id === activeAgent.agentType)
			: null;

		if (!activeAgentType || !activeAgent) return null;

		const hasModels =
			activeAgentType.models && activeAgentType.models.length > 0;
		const hasModes = activeAgentType.modes && activeAgentType.modes.length > 0;

		if (!hasModels && !hasModes) return null;

		const agentIcons = getAgentIcons(activeAgent);

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
							{activeAgentType.models?.map((model) => (
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
							{activeAgentType.modes?.map((m) => (
								<DropdownMenuItem
									key={m.id}
									onClick={() => setSelectedModeId(m.id)}
									className={cn(
										"flex-col items-start gap-0.5",
										m.id === selectedModeId && "bg-accent",
									)}
								>
									<span className="font-medium">{m.name}</span>
									{m.description && (
										<span className="text-xs text-muted-foreground">
											{m.description}
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

	// Unified layout with CSS transitions based on mode
	return (
		<div
			className={cn(
				"flex flex-col h-full bg-background transition-all duration-300 ease-in-out",
				mode === "welcome" && "justify-center",
				className,
			)}
		>
			{/* Welcome header - fades out when in conversation mode */}
			<div
				className={cn(
					"flex flex-col items-center transition-all duration-300 ease-in-out overflow-hidden",
					mode === "welcome"
						? "opacity-100 max-h-[200px] py-6"
						: "opacity-0 max-h-0 py-0",
				)}
			>
				<div className="text-center space-y-2">
					<MessageSquare className="h-12 w-12 mx-auto text-muted-foreground/50" />
					<h2 className="text-xl font-semibold">Start a new session</h2>
					<p className="text-muted-foreground text-sm">
						Describe what you want to work on and I'll help you get started.
					</p>
				</div>
			</div>

			{/* Session status indicator - shows during initialization */}
			{selectedSession &&
				selectedSession.status !== "running" &&
				selectedSession.status !== "closed" && (
					<div
						className={cn(
							"flex items-center justify-center gap-2 py-3 px-4 border-b",
							selectedSession.status === "error"
								? "bg-destructive/10 border-destructive/20 text-destructive"
								: "bg-muted/50 border-border text-muted-foreground",
						)}
					>
						{getStatusDisplay(selectedSession.status).icon}
						<span className="text-sm font-medium">
							{getStatusDisplay(selectedSession.status).text}
						</span>
						{selectedSession.status === "error" &&
							selectedSession.errorMessage && (
								<span className="text-sm">
									: {selectedSession.errorMessage}
								</span>
							)}
					</div>
				)}

			{/* Chat stream error indicator */}
			{hasError && chatError && (
				<div className="flex items-center gap-2 py-3 px-4 border-b bg-destructive/10 border-destructive/20 text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span className="text-sm font-medium">Error</span>
					<span className="text-sm">: {chatError.message}</span>
				</div>
			)}

			{/* Agent/Workspace selectors - fade out in conversation mode */}
			<div
				className={cn(
					"flex flex-col items-center gap-3 transition-all duration-300 ease-in-out overflow-hidden",
					mode === "welcome"
						? "opacity-100 max-h-[120px] py-4"
						: "opacity-0 max-h-0 py-0",
				)}
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
							<DropdownMenuItem
								onClick={() => dialogs.openAgentDialog()}
								className="gap-2"
							>
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
									<WorkspaceIcon path={ws.path} className="h-4 w-4 shrink-0" />
									<span className="truncate">
										{getWorkspaceDisplayName(ws.path)}
									</span>
								</DropdownMenuItem>
							))}
							{workspaces.length > 0 && <DropdownMenuSeparator />}
							<DropdownMenuItem
								onClick={dialogs.openWorkspaceDialog}
								className="gap-2"
							>
								<Plus className="h-4 w-4" />
								<span>Add Workspace</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			{/* Conversation area - expands in conversation mode */}
			<Conversation
				className={cn(
					"transition-all duration-300 ease-in-out",
					mode === "welcome" ? "flex-none h-0 opacity-0" : "flex-1 opacity-100",
				)}
			>
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
										{group.messages.map((message, messageIdx) => {
											const textContent = getMessageText(message);
											return (
												<MessageRoleProvider
													key={message.id}
													role={message.role}
												>
													<Message from={message.role}>
														<MessageContent>
															<div className="text-xs font-medium text-muted-foreground mb-1">
																{message.role === "user" ? "You" : "Assistant"}
															</div>
															<MessageResponse>{textContent}</MessageResponse>
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
																			onClick={() => handleCopy(textContent)}
																		>
																			<Copy className="size-3" />
																		</MessageAction>
																	</MessageActions>
																)}
														</MessageContent>
													</Message>
												</MessageRoleProvider>
											);
										})}
									</div>
								</div>
							))}
						</div>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			{/* Input area - transitions from centered/large to bottom/compact */}
			<div
				className={cn(
					"shrink-0 transition-all duration-300 ease-in-out",
					mode === "welcome"
						? "px-8 py-4 max-w-2xl mx-auto w-full"
						: "px-4 py-4 border-t border-border",
				)}
			>
				<Input
					onSubmit={handleSubmit}
					value={input}
					onChange={setInput}
					status={status}
					className="max-w-full"
				>
					<PromptInputAttachmentsPreview />
					<PromptInputTextarea
						placeholder={
							mode === "welcome"
								? "What would you like to work on?"
								: "Type a message..."
						}
						className={cn(
							"transition-all duration-300",
							mode === "welcome" ? "min-h-[80px] text-base" : "min-h-[60px]",
						)}
					/>
					<PromptInputToolbar>
						<PromptInputTools>
							<PromptInputAttachment />
							<ModelModeSelector />
						</PromptInputTools>
						<PromptInputSubmit
							status={status}
							disabled={
								mode === "welcome" &&
								(!localSelectedWorkspaceId || !localSelectedAgentId)
							}
						/>
					</PromptInputToolbar>
				</Input>
			</div>
		</div>
	);
}
