"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, generateId, type UIMessage } from "ai";
import { AnimatePresence, motion } from "framer-motion";
import {
	AlertCircle,
	Bot,
	CheckCircle,
	ChevronDown,
	Copy,
	Loader2,
	MessageSquare,
	Play,
	Plus,
	RefreshCcw,
	Search,
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
import { type PlanEntry, PlanQueue } from "@/components/ai-elements/plan-queue";
import {
	type FileUIPart,
	Input,
	PromptInputAttachment,
	PromptInputAttachmentsPreview,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputToolbar,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ImageAttachment } from "@/components/ai-elements/image-attachment";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	ToolCall,
	type ToolCallPart,
} from "@/components/ai-elements/tool-call";
import { IconRenderer } from "@/components/ide/icon-renderer";
import {
	getWorkspaceDisplayPath,
	WorkspaceIcon,
} from "@/components/ide/workspace-path";
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
import { useSession } from "@/lib/hooks/use-sessions";
import { cn } from "@/lib/utils";

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

// Helper to extract the latest plan from messages
// Looks for TodoWrite tool calls with plan entries as output
function extractLatestPlan(messages: UIMessage[]): PlanEntry[] | null {
	// Iterate backwards through messages to find the most recent plan
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;

		// Look through parts backwards to find latest TodoWrite tool call
		for (let j = message.parts.length - 1; j >= 0; j--) {
			const part = message.parts[j];
			if (
				part.type === "dynamic-tool" &&
				part.toolName === "TodoWrite" &&
				part.state === "output-available" &&
				Array.isArray(part.output)
			) {
				// Validate that output looks like plan entries
				const entries = part.output as unknown[];
				if (
					entries.length > 0 &&
					typeof entries[0] === "object" &&
					entries[0] !== null &&
					"content" in entries[0] &&
					"status" in entries[0]
				) {
					return entries as PlanEntry[];
				}
			}
		}
	}
	return null;
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
		case "reinitializing":
			return {
				text: "Reinitializing sandbox...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "cloning":
			return {
				text: "Cloning repository...",
				icon: <Loader2 className="h-4 w-4 animate-spin" />,
				isLoading: true,
			};
		case "pulling_image":
			return {
				text: "Pulling container image...",
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
		case "stopped":
			return {
				text: "Session stopped",
				icon: <AlertCircle className="h-4 w-4 text-yellow-500" />,
				isLoading: false,
			};
		case "error":
			return {
				text: "Session error",
				icon: <AlertCircle className="h-4 w-4 text-destructive" />,
				isLoading: false,
			};
		case "closed":
			return {
				text: "Session closed",
				icon: <CheckCircle className="h-4 w-4 text-muted-foreground" />,
				isLoading: false,
			};
		case "removing":
			return {
				text: "Removing session...",
				icon: <Loader2 className="h-4 w-4 animate-spin text-destructive" />,
				isLoading: true,
			};
		case "removed":
			return {
				text: "Session removed",
				icon: <AlertCircle className="h-4 w-4 text-muted-foreground" />,
				isLoading: false,
			};
		default:
			return {
				text: String(status),
				icon: <AlertCircle className="h-4 w-4 text-muted-foreground" />,
				isLoading: false,
			};
	}
}

// Memoized input area component to prevent re-renders when typing
interface ChatInputAreaProps {
	mode: "welcome" | "conversation";
	status: "ready" | "streaming";
	selectedSessionId: string | null;
	localSelectedWorkspaceId: string | null;
	localSelectedAgentId: string | null;
	handleSubmit: (
		message: { text?: string; files?: FileList | FileUIPart[] },
		e: React.FormEvent,
	) => void;
	ModelModeSelector: React.ComponentType;
}

const ChatInputArea = React.memo(function ChatInputArea({
	mode,
	status,
	selectedSessionId,
	localSelectedWorkspaceId,
	localSelectedAgentId,
	handleSubmit,
	ModelModeSelector,
}: ChatInputAreaProps) {
	return (
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
				status={status}
				className="max-w-full"
				sessionId={selectedSessionId}
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
	);
});

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
		handleNewSession,
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
	const [isPlanOpen, setIsPlanOpen] = React.useState(true);

	// Fetch session data to check if session exists
	const { error: sessionError, isLoading: sessionLoading } =
		useSession(selectedSessionId);

	// Fetch existing messages when a session is selected
	// Use selectedSessionId directly (not derived selectedSession) to avoid stale cache issues
	const { messages: existingMessages, error: messagesError } =
		useMessages(selectedSessionId);

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
	// Memoize the onError callback to prevent useChat from re-initializing
	const handleChatError = React.useCallback((error: Error) => {
		console.error("Chat stream error:", error);
	}, []);

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
		onError: handleChatError,
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

	// Check if session is not found (fetch returned error and we're not loading)
	const sessionNotFound =
		!!selectedSessionId && !!sessionError && !sessionLoading;

	// Determine mode based on whether we have messages or a session
	// Use truthiness check since props may be undefined when not passed
	// Include selectedSessionId to handle cases where the session object hasn't loaded yet
	const hasSession =
		!!sessionAgent || !!sessionWorkspace || !!selectedSessionId;

	// Mode is "conversation" if we have a session or messages (but not if session not found)
	const mode: ChatMode =
		!sessionNotFound && (hasSession || messages.length > 0)
			? "conversation"
			: "welcome";

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

	// When workspaceSelectTrigger fires, update local workspace selection and show shimmer
	React.useEffect(() => {
		if (workspaceSelectTrigger && workspaceSelectTrigger > 0) {
			// Update local workspace to the preselected one
			if (preselectedWorkspaceId) {
				setLocalSelectedWorkspaceId(preselectedWorkspaceId);
			}
			setIsShimmering(true);
			const timeout = setTimeout(() => setIsShimmering(false), 600);
			return () => clearTimeout(timeout);
		}
	}, [workspaceSelectTrigger, preselectedWorkspaceId]);

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

	// Extract the current plan from messages
	const currentPlan = React.useMemo(
		() => extractLatestPlan(messages),
		[messages],
	);

	// Handle form submission - memoized to prevent Input re-renders
	const handleSubmit = React.useCallback(
		async (
			message: {
				text?: string;
				files?:
					| FileList
					| {
							type: "file";
							filename: string;
							mediaType: string;
							url: string;
					  }[];
			},
			e: React.FormEvent,
		) => {
			e.preventDefault();
			const messageText = message.text;
			if (!messageText?.trim() || isLoading) return;

			// Validate selections for new sessions
			if (
				!selectedSessionId &&
				(!localSelectedWorkspaceId || !localSelectedAgentId)
			) {
				return;
			}

			// Track if this is a new session so we can notify parent after success
			const isNewSession = !selectedSessionId && pendingSessionId;

			try {
				await sendMessage({ text: messageText, files: message.files });

				// For new chats, notify parent about the session ID AFTER the POST succeeds
				// This ensures the session exists on the server before the client tries to use it
				if (isNewSession) {
					handleSessionCreated(pendingSessionId);
				}
			} catch (err) {
				console.error("Failed to send message:", err);
			}
		},
		[
			isLoading,
			selectedSessionId,
			localSelectedWorkspaceId,
			localSelectedAgentId,
			pendingSessionId,
			sendMessage,
			handleSessionCreated,
		],
	);

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
			{/* Session not found message */}
			{sessionNotFound && (
				<div className="flex flex-col items-center justify-center flex-1 py-6">
					<div className="text-center space-y-4">
						<Search className="h-12 w-12 mx-auto text-muted-foreground/50" />
						<h2 className="text-xl font-semibold">Session not found</h2>
						<p className="text-muted-foreground text-sm">
							The session you're looking for doesn't exist or has been deleted.
						</p>
						<Button variant="outline" onClick={handleNewSession}>
							Start a new session
						</Button>
					</div>
				</div>
			)}

			{/* Welcome header - animated in/out based on mode */}
			<AnimatePresence>
				{mode === "welcome" && !sessionNotFound && (
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

			{/* Session status header - shows when not running */}
			{selectedSession && selectedSession.status !== "running" && (
				<div
					className={cn(
						"flex items-center gap-2 py-3 px-4 border-b",
						selectedSession.status === "error" ||
							selectedSession.status === "removing"
							? "bg-destructive/10 border-destructive/20"
							: selectedSession.status === "stopped"
								? "bg-yellow-500/10 border-yellow-500/20"
								: selectedSession.status === "closed" ||
										selectedSession.status === "removed"
									? "bg-muted/30 border-border"
									: "bg-muted/50 border-border",
					)}
				>
					{getStatusDisplay(selectedSession.status).icon}
					<span
						className={cn(
							"text-sm font-medium",
							selectedSession.status === "error" ||
								selectedSession.status === "removing"
								? "text-destructive"
								: selectedSession.status === "stopped"
									? "text-yellow-600 dark:text-yellow-500"
									: "text-muted-foreground",
						)}
					>
						{getStatusDisplay(selectedSession.status).text}
					</span>
					{selectedSession.status === "error" &&
						selectedSession.errorMessage && (
							<span className="text-sm text-destructive flex-1">
								- {selectedSession.errorMessage}
							</span>
						)}
				</div>
			)}

			{/* Messages loading error indicator */}
			{messagesError && (
				<div className="flex items-center gap-2 py-3 px-4 border-b bg-destructive/10 border-destructive/20 text-destructive">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span className="text-sm font-medium">Failed to load messages</span>
					<span className="text-sm">: {messagesError.message}</span>
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

			{/* Agent/Workspace selectors - animated in/out based on mode */}
			<AnimatePresence>
				{mode === "welcome" && !sessionNotFound && (
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
												<div
													className="flex items-center gap-2 truncate"
													title={selectedWorkspace.path}
												>
													<WorkspaceIcon
														path={selectedWorkspace.path}
														className="h-4 w-4 shrink-0"
													/>
													<span className="truncate">
														{getWorkspaceDisplayPath(
															selectedWorkspace.path,
															selectedWorkspace.sourceType,
														)}
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
											title={ws.path}
										>
											<WorkspaceIcon
												path={ws.path}
												className="h-4 w-4 shrink-0"
											/>
											<span className="truncate">
												{getWorkspaceDisplayPath(ws.path, ws.sourceType)}
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
					</motion.div>
				)}
			</AnimatePresence>

			{/* Conversation area - expands in conversation mode */}
			{!sessionNotFound && (
				<Conversation
					className={cn(
						"transition-all duration-300 ease-in-out",
						mode === "welcome"
							? "flex-none h-0 opacity-0"
							: "flex-1 opacity-100",
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
																	{message.role === "user"
																		? "You"
																		: "Assistant"}
																</div>
																{/* Render message parts in order */}
																{message.parts.map((part, partIdx) => {
																	if (part.type === "text") {
																		return (
																			// biome-ignore lint/suspicious/noArrayIndexKey: Text parts have no unique ID, order is stable
																			<MessageResponse key={`text-${partIdx}`}>
																				{part.text}
																			</MessageResponse>
																		);
																	}
																	if (part.type === "file") {
																		const filePart = part as FileUIPart;
																		if (filePart.mediaType?.startsWith("image/")) {
																			return (
																				<ImageAttachment
																					// biome-ignore lint/suspicious/noArrayIndexKey: File parts have no unique ID, order is stable
																					key={`file-${partIdx}`}
																					src={filePart.url}
																					filename={filePart.filename}
																				/>
																			);
																		}
																		// Non-image file attachment
																		return (
																			<div
																				// biome-ignore lint/suspicious/noArrayIndexKey: File parts have no unique ID, order is stable
																				key={`file-${partIdx}`}
																				className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
																			>
																				<span className="text-muted-foreground">
																					📎 {filePart.filename}
																				</span>
																			</div>
																		);
																	}
																	if (part.type === "dynamic-tool") {
																		return (
																			<ToolCall
																				key={part.toolCallId}
																				part={part as ToolCallPart}
																			/>
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
								{/* Show shimmer status when waiting for assistant response */}
								{isLoading && (
									<div className="flex items-center gap-2 pl-3 py-2">
										<Shimmer className="text-sm" duration={1.5}>
											AI is thinking...
										</Shimmer>
									</div>
								)}
							</div>
						)}
					</ConversationContent>
					<ConversationScrollButton />
				</Conversation>
			)}

			{/* Plan queue - shows when there's an active plan in conversation mode */}
			{!sessionNotFound && mode === "conversation" && currentPlan && (
				<PlanQueue
					entries={currentPlan}
					isOpen={isPlanOpen}
					onOpenChange={setIsPlanOpen}
				/>
			)}

			{/* Input area - transitions from centered/large to bottom/compact */}
			{!sessionNotFound && (
				<ChatInputArea
					mode={mode}
					status={status}
					selectedSessionId={selectedSessionId}
					localSelectedWorkspaceId={localSelectedWorkspaceId}
					localSelectedAgentId={localSelectedAgentId}
					handleSubmit={handleSubmit}
					ModelModeSelector={ModelModeSelector}
				/>
			)}
		</div>
	);
}
