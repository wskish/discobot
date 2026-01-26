"use client";

import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	type DynamicToolUIPart,
	type FileUIPart,
	generateId,
	type UIMessage,
} from "ai";
import {
	AlertCircle,
	CheckCircle,
	Copy,
	Loader2,
	MessageSquare,
	Paperclip,
	RefreshCcw,
	Search,
} from "lucide-react";
import dynamic from "next/dynamic";

// Lazy-load Framer Motion components to reduce initial bundle size (~35KB)
const WelcomeHeader = dynamic(
	() =>
		import("@/components/ide/welcome-animation").then(
			(mod) => mod.WelcomeHeader,
		),
	{ ssr: false },
);
const WelcomeSelectors = dynamic(
	() =>
		import("@/components/ide/welcome-animation").then(
			(mod) => mod.WelcomeSelectors,
		),
	{ ssr: false },
);

import * as React from "react";
import { useSWRConfig } from "swr";
import {
	Attachment,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ImageAttachment } from "@/components/ai-elements/image-attachment";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	PromptInput,
	PromptInputActionAddAttachments,
	PromptInputActionMenu,
	PromptInputActionMenuContent,
	PromptInputActionMenuTrigger,
	PromptInputFooter,
	type PromptInputMessage,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import {
	Queue,
	QueueItem,
	QueueItemContent,
	QueueItemDescription,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { getApiBase } from "@/lib/api-config";
import {
	CommitStatus,
	SessionStatus as SessionStatusConstants,
} from "@/lib/api-constants";
import type { Agent, SessionStatus } from "@/lib/api-types";
import { useAgentContext } from "@/lib/contexts/agent-context";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useLazyRender } from "@/lib/hooks/use-lazy-render";
import { useMessages } from "@/lib/hooks/use-messages";
import { usePromptHistory } from "@/lib/hooks/use-prompt-history";
import { useSession } from "@/lib/hooks/use-sessions";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { cn } from "@/lib/utils";
import { PromptHistoryDropdown } from "./prompt-history-dropdown";

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

// Plan entry structure from TodoWrite tool
interface PlanEntry {
	content: string;
	status: "pending" | "in_progress" | "completed";
	priority?: "low" | "medium" | "high";
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
		case "ready":
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

// Attachments preview component using new API
function AttachmentsPreview() {
	const attachments = usePromptInputAttachments();

	if (attachments.files.length === 0) {
		return null;
	}

	return (
		<Attachments variant="inline" className="px-3 pt-3 pb-0">
			{attachments.files.map((file) => (
				<Attachment
					key={file.id}
					data={file}
					onRemove={() => attachments.remove(file.id)}
				>
					<AttachmentPreview />
					<span className="truncate max-w-[120px] text-xs">
						{file.filename}
					</span>
					<AttachmentRemove />
				</Attachment>
			))}
		</Attachments>
	);
}

// Memoized message item to prevent re-renders when messages array updates
interface MessageItemProps {
	message: UIMessage;
	onCopy: (text: string) => void;
	onRegenerate: () => void;
}

const MessageItem = React.memo(function MessageItem({
	message,
	onCopy,
	onRegenerate,
}: MessageItemProps) {
	const textContent = React.useMemo(() => getMessageText(message), [message]);

	return (
		<Message from={message.role}>
			<MessageContent>
				<div className="text-xs font-medium text-muted-foreground mb-1">
					{message.role === "user" ? "You" : "Assistant"}
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
						const toolPart = part as DynamicToolUIPart;
						return (
							<Tool key={toolPart.toolCallId}>
								<ToolHeader
									type={toolPart.type}
									state={toolPart.state}
									toolName={toolPart.toolName}
									title={toolPart.title}
								/>
								<ToolContent>
									<ToolInput input={toolPart.input} />
									<ToolOutput
										output={toolPart.output}
										errorText={toolPart.errorText}
									/>
								</ToolContent>
							</Tool>
						);
					}
					return null;
				})}
				{message.role === "assistant" && (
					<MessageActions>
						<MessageAction
							label="Retry"
							tooltip="Regenerate response"
							onClick={onRegenerate}
						>
							<RefreshCcw className="size-3" />
						</MessageAction>
						<MessageAction
							label="Copy"
							tooltip="Copy to clipboard"
							onClick={() => onCopy(textContent)}
						>
							<Copy className="size-3" />
						</MessageAction>
					</MessageActions>
				)}
			</MessageContent>
		</Message>
	);
});

// Lazy-rendered message wrapper - defers rendering until first visible
// Uses IntersectionObserver to detect visibility, then keeps message rendered
interface LazyMessageItemProps extends MessageItemProps {
	/** Estimated height for placeholder before render (prevents layout shift) */
	estimatedHeight?: number;
}

// IntersectionObserver options - use rootMargin to pre-render messages
// slightly before they enter the viewport for smoother scrolling
const LAZY_OBSERVER_OPTIONS: IntersectionObserverInit = {
	rootMargin: "200px 0px", // Pre-render 200px above/below viewport
};

const LazyMessageItem = React.memo(function LazyMessageItem({
	message,
	onCopy,
	onRegenerate,
	estimatedHeight = 100,
}: LazyMessageItemProps) {
	const [ref, hasBeenVisible] = useLazyRender(LAZY_OBSERVER_OPTIONS);

	return (
		<div ref={ref}>
			{hasBeenVisible ? (
				<MessageItem
					message={message}
					onCopy={onCopy}
					onRegenerate={onRegenerate}
				/>
			) : (
				// Placeholder with estimated height to maintain scroll position
				<div
					className="flex items-center justify-center text-muted-foreground/30"
					style={{ minHeight: estimatedHeight }}
				>
					<Loader2 className="h-4 w-4 animate-spin" />
				</div>
			)}
		</div>
	);
});

// Memoized input area component to prevent re-renders when typing
interface ChatInputAreaProps {
	mode: "welcome" | "conversation";
	status: "ready" | "streaming" | "submitted" | "error";
	localSelectedWorkspaceId: string | null;
	localSelectedAgentId: string | null;
	handleSubmit: (message: PromptInputMessage, e: React.FormEvent) => void;
	/** Whether input is locked (e.g., during commit) */
	isLocked?: boolean;
	/** Message to show when locked */
	lockedMessage?: string;
	/** Session ID for draft persistence */
	selectedSessionId: string | null;
}

const ChatInputArea = React.memo(function ChatInputArea({
	mode,
	status,
	localSelectedWorkspaceId,
	localSelectedAgentId,
	handleSubmit,
	isLocked = false,
	lockedMessage,
	selectedSessionId,
}: ChatInputAreaProps) {
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);

	const {
		history,
		historyIndex,
		isHistoryOpen,
		setHistoryIndex,
		onSelectHistory,
		addToHistory,
		closeHistory,
		handleKeyDown: historyKeyDown,
	} = usePromptHistory({
		textareaRef,
		sessionId: selectedSessionId,
	});

	// Wrap handleSubmit to also add to history
	const wrappedHandleSubmit = React.useCallback(
		(message: PromptInputMessage, e: React.FormEvent) => {
			const text = message.text;
			handleSubmit(message, e);
			// Add to history after submit
			if (text) {
				addToHistory(text);
			}
		},
		[handleSubmit, addToHistory],
	);

	return (
		<div
			className={cn(
				"shrink-0 transition-all duration-300 ease-in-out",
				mode === "welcome"
					? "px-8 py-4 max-w-2xl mx-auto w-full"
					: "px-4 py-4 border-t border-border max-w-3xl mx-auto w-full",
			)}
		>
			<div className="relative">
				<PromptHistoryDropdown
					history={history}
					historyIndex={historyIndex}
					isHistoryOpen={isHistoryOpen}
					setHistoryIndex={setHistoryIndex}
					onSelectHistory={onSelectHistory}
					textareaRef={textareaRef}
					closeHistory={closeHistory}
				/>
				<PromptInput
					onSubmit={wrappedHandleSubmit}
					className="max-w-full"
					accept="image/*"
				>
					<AttachmentsPreview />
					<PromptInputTextarea
						ref={textareaRef}
						placeholder={
							isLocked
								? lockedMessage || "Input disabled"
								: mode === "welcome"
									? "What would you like to work on?"
									: "Type a message..."
						}
						disabled={isLocked}
						onKeyDown={historyKeyDown}
						className={cn(
							"transition-all duration-300",
							mode === "welcome" ? "min-h-[80px] text-base" : "min-h-[60px]",
							isLocked && "opacity-50 cursor-not-allowed",
						)}
					/>
					<PromptInputFooter>
						<PromptInputTools>
							<PromptInputActionMenu>
								<PromptInputActionMenuTrigger>
									<Paperclip className="size-4" />
								</PromptInputActionMenuTrigger>
								<PromptInputActionMenuContent>
									<PromptInputActionAddAttachments />
								</PromptInputActionMenuContent>
							</PromptInputActionMenu>
						</PromptInputTools>
						<PromptInputSubmit
							status={status}
							disabled={
								isLocked ||
								(mode === "welcome" &&
									(!localSelectedWorkspaceId || !localSelectedAgentId))
							}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	);
});

export function ChatPanel({ className }: ChatPanelProps) {
	// Get data from contexts
	const { workspaces } = useWorkspaces();
	const { agents, agentTypes, selectedAgentId } = useAgentContext();
	const {
		selectedSessionId,
		selectedSession,
		preselectedWorkspaceId,
		workspaceSelectTrigger,
		handleSessionCreated,
		handleNewSession,
	} = useSessionContext();
	const { agentDialog, workspaceDialog } = useDialogContext();

	// Derive sessionAgent and sessionWorkspace from selectedSession
	const sessionAgent = selectedSession
		? agents.find((a) => a.id === selectedSession.agentId)
		: undefined;
	const sessionWorkspace = selectedSession
		? workspaces.find((w) => w.id === selectedSession.workspaceId)
		: undefined;

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
	const [isShimmering, setIsShimmering] = React.useState(false);

	// Fetch session data to check if session exists
	const { error: sessionError, isLoading: sessionLoading } =
		useSession(selectedSessionId);

	// Fetch existing messages when a session is selected
	// Use selectedSessionId directly (not derived selectedSession) to avoid stale cache issues
	const {
		messages: existingMessages,
		error: messagesError,
		isLoading: messagesLoading,
	} = useMessages(selectedSessionId);

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
		// Only try to resume streams for existing sessions (not new pending sessions)
		// The SDK's resumeStream fails if called without an existing session/stream state
		resume: !!selectedSessionId,
	});

	// Sync existingMessages to useChat state when they load or when chatId changes
	// This is needed because the messages prop only sets initial state
	// When chatId changes (session switch), we MUST update messages immediately to prevent
	// stale messages from the previous session appearing after a stream finishes
	const prevSyncRef = React.useRef<{
		chatId: string | null;
		messageIds: string;
	}>({
		chatId: null,
		messageIds: "",
	});
	React.useEffect(() => {
		// Compare by message IDs to detect actual content changes
		const messageIds = existingMessages.map((m) => m.id).join(",");
		const needsSync =
			prevSyncRef.current.chatId !== chatId ||
			prevSyncRef.current.messageIds !== messageIds;

		if (needsSync) {
			setMessages(existingMessages);
			prevSyncRef.current = { chatId, messageIds };
		}
	}, [existingMessages, setMessages, chatId]);

	// Derive loading state from chat status
	const isLoading = chatStatus === "streaming" || chatStatus === "submitted";
	const hasError = chatStatus === "error";

	// Refresh diff data when chat finishes
	const { mutate } = useSWRConfig();
	const prevChatStatus = React.useRef(chatStatus);
	const prevChatId = React.useRef(chatId);
	React.useEffect(() => {
		// When status changes from streaming/submitted to ready, refresh the diff
		const wasLoading =
			prevChatStatus.current === "streaming" ||
			prevChatStatus.current === "submitted";
		const isNowReady = chatStatus === "ready";
		// Only refresh if chatId hasn't changed (user didn't switch sessions mid-stream)
		const isSameChat = prevChatId.current === chatId;

		if (wasLoading && isNowReady && selectedSessionId && isSameChat) {
			// Refresh the diff data for this session
			mutate(`session-diff-${selectedSessionId}-files`);
		}

		prevChatStatus.current = chatStatus;
		prevChatId.current = chatId;
	}, [chatStatus, selectedSessionId, mutate, chatId]);

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

	// Extract the current plan from messages
	const currentPlan = React.useMemo(
		() => extractLatestPlan(messages),
		[messages],
	);

	// Handle form submission - memoized to prevent PromptInput re-renders
	const handleSubmit = React.useCallback(
		async (message: PromptInputMessage, e: React.FormEvent) => {
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
				// IMPORTANT: Only call handleSessionCreated if the user hasn't switched sessions
				// during the async sendMessage operation. Use selectionRef to get the CURRENT
				// selectedSessionId, not the one captured in the callback closure.
				if (isNewSession && selectionRef.current.sessionId === null) {
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

	const handleCopy = React.useCallback((text: string) => {
		navigator.clipboard.writeText(text);
	}, []);

	const handleRegenerate = React.useCallback(() => {
		console.log("Regenerate last response");
	}, []);

	// Use chat status directly for the PromptInputSubmit component
	const inputStatus = chatStatus;

	const getAgentIcons = (agent: Agent) => {
		const agentType = agentTypes.find((t) => t.id === agent.agentType);
		return agentType?.icons;
	};

	// Unified layout with CSS transitions based on mode
	return (
		<div
			className={cn(
				"relative flex flex-col h-full bg-background transition-all duration-300 ease-in-out",
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
			<WelcomeHeader show={mode === "welcome" && !sessionNotFound} />

			{/* Session status header - shows when not ready */}
			{selectedSession &&
				selectedSession.status !== SessionStatusConstants.READY && (
					<div
						className={cn(
							"flex items-center gap-2 py-3 px-4 border-b",
							selectedSession.status === SessionStatusConstants.ERROR ||
								selectedSession.status === SessionStatusConstants.REMOVING
								? "bg-destructive/10 border-destructive/20"
								: selectedSession.status === SessionStatusConstants.STOPPED
									? "bg-yellow-500/10 border-yellow-500/20"
									: selectedSession.status === SessionStatusConstants.REMOVED
										? "bg-muted/30 border-border"
										: "bg-muted/50 border-border",
						)}
					>
						{getStatusDisplay(selectedSession.status).icon}
						<span
							className={cn(
								"text-sm font-medium",
								selectedSession.status === SessionStatusConstants.ERROR ||
									selectedSession.status === SessionStatusConstants.REMOVING
									? "text-destructive"
									: selectedSession.status === SessionStatusConstants.STOPPED
										? "text-yellow-600 dark:text-yellow-500"
										: "text-muted-foreground",
							)}
						>
							{getStatusDisplay(selectedSession.status).text}
						</span>
						{selectedSession.status === SessionStatusConstants.ERROR &&
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
			<WelcomeSelectors
				show={mode === "welcome" && !sessionNotFound}
				agents={agents}
				workspaces={workspaces}
				selectedAgent={selectedAgent}
				selectedWorkspace={selectedWorkspace}
				isShimmering={isShimmering}
				getAgentIcons={getAgentIcons}
				onSelectAgent={setLocalSelectedAgentId}
				onSelectWorkspace={setLocalSelectedWorkspaceId}
				onAddAgent={() => agentDialog.open()}
				onAddWorkspace={() => workspaceDialog.open()}
			/>

			{/* Conversation area - expands in conversation mode */}
			{/* Show loading state while fetching messages for existing session */}
			{!sessionNotFound &&
				selectedSessionId &&
				messagesLoading &&
				mode === "conversation" && (
					<div className="flex-1 flex items-center justify-center">
						<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				)}
			{/* Only render Conversation once messages are loaded (or for new sessions) */}
			{!sessionNotFound && (!selectedSessionId || !messagesLoading) && (
				<Conversation
					className={cn(
						"transition-all duration-300 ease-in-out",
						mode === "welcome"
							? "flex-none h-0 opacity-0"
							: "flex-1 opacity-100",
					)}
				>
					<ConversationContent className="p-4">
						{messages.length === 0 ? (
							<ConversationEmptyState
								icon={<MessageSquare className="size-12 opacity-50" />}
								title="Start a conversation"
								description="Type a message below to begin chatting with the AI assistant."
							/>
						) : (
							<div className="max-w-3xl mx-auto w-full space-y-4">
								{messages.map((message, index) => {
									// Render last few messages immediately (they're likely visible)
									// Lazy-render older messages to improve initial load performance
									const isRecentMessage = index >= messages.length - 3;
									return isRecentMessage ? (
										<MessageItem
											key={message.id}
											message={message}
											onCopy={handleCopy}
											onRegenerate={handleRegenerate}
										/>
									) : (
										<LazyMessageItem
											key={message.id}
											message={message}
											onCopy={handleCopy}
											onRegenerate={handleRegenerate}
											estimatedHeight={message.role === "user" ? 80 : 150}
										/>
									);
								})}
								{/* Show shimmer status when waiting for assistant response */}
								{isLoading && (
									<div className="flex items-center gap-2 py-2">
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
				<Queue className="border-t border-x-0 border-b-0 rounded-none shadow-none">
					<QueueSection>
						<QueueSectionTrigger>
							<QueueSectionLabel
								count={currentPlan.length}
								label={`Todo (${currentPlan.filter((e) => e.status === "completed").length} completed)`}
							/>
						</QueueSectionTrigger>
						<QueueSectionContent>
							<QueueList>
								{currentPlan.map((entry, index) => {
									const isCompleted = entry.status === "completed";
									const isInProgress = entry.status === "in_progress";

									return (
										<QueueItem
											// biome-ignore lint/suspicious/noArrayIndexKey: Plan entries don't have unique IDs
											key={index}
											className={cn(isInProgress && "bg-blue-500/10")}
										>
											<div className="flex items-center gap-2">
												{isInProgress ? (
													<Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
												) : (
													<QueueItemIndicator completed={isCompleted} />
												)}
												<QueueItemContent completed={isCompleted}>
													{entry.content}
												</QueueItemContent>
											</div>
											{entry.priority && (
												<QueueItemDescription completed={isCompleted}>
													Priority: {entry.priority}
												</QueueItemDescription>
											)}
										</QueueItem>
									);
								})}
							</QueueList>
						</QueueSectionContent>
					</QueueSection>
				</Queue>
			)}

			{/* Input area - transitions from centered/large to bottom/compact */}
			{!sessionNotFound && (
				<ChatInputArea
					mode={mode}
					status={inputStatus}
					localSelectedWorkspaceId={localSelectedWorkspaceId}
					localSelectedAgentId={localSelectedAgentId}
					handleSubmit={handleSubmit}
					isLocked={
						selectedSession?.commitStatus === CommitStatus.PENDING ||
						selectedSession?.commitStatus === CommitStatus.COMMITTING
					}
					lockedMessage="Chat disabled during commit..."
					selectedSessionId={selectedSessionId}
				/>
			)}

			{/* Session ID - subtle display in lower right */}
			{selectedSessionId && mode === "conversation" && (
				<div className="absolute bottom-2 right-2 select-text">
					<span className="text-[10px] text-muted-foreground/50 font-mono">
						{selectedSessionId}
					</span>
				</div>
			)}
		</div>
	);
}
