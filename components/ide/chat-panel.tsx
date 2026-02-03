import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertCircle } from "lucide-react";

import * as React from "react";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { ChatConversation } from "@/components/ide/chat-conversation";
import { ChatNewContent } from "@/components/ide/chat-new-content";
import {
	ChatPlanQueue,
	QueueButton,
	QueuePanel,
} from "@/components/ide/chat-plan-queue";
import { PromptInputWithHistory } from "@/components/ide/prompt-input-with-history";
import { getApiBase } from "@/lib/api-config";
import {
	CommitStatus,
	SessionStatus as SessionStatusConstants,
} from "@/lib/api-constants";
import { useMessages } from "@/lib/hooks/use-messages";
import { useSession } from "@/lib/hooks/use-sessions";
import {
	getSessionHoverText,
	getSessionStatusIndicator,
} from "@/lib/session-utils";
import { cn } from "@/lib/utils";

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
	/** Session ID for the chat (required) */
	sessionId: string;
	/** Initial messages for resuming an existing session. If provided, this is a resume scenario. */
	initialMessages?: UIMessage[];
	/** Initial workspace ID (from context, passed down as prop) */
	initialWorkspaceId: string | null;
	/** Callback when a new session is created - receives session ID, workspace ID, and agent ID */
	onSessionCreated?: (
		sessionId: string,
		workspaceId: string,
		agentId: string,
	) => void;
	/** Callback when chat completes (for refreshing file data) */
	onChatComplete?: () => void;
	/** Optional className */
	className?: string;
}

export function ChatPanel({
	sessionId,
	initialMessages,
	initialWorkspaceId,
	onSessionCreated,
	onChatComplete,
	className,
}: ChatPanelProps) {
	// Determine if this is a resume scenario based on initialMessages
	const resume = initialMessages !== undefined;

	// State for new session workspace selection
	// Agent selection is managed entirely within ChatNewContent via persistent storage
	const [localSelectedWorkspaceId, setLocalSelectedWorkspaceId] =
		React.useState<string | null>(null);
	const [localSelectedAgentId, setLocalSelectedAgentId] = React.useState<
		string | null
	>(null);

	// Ref for textarea to enable focusing
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);

	// Focus textarea when showing new session screen
	React.useEffect(() => {
		if (!resume && textareaRef.current) {
			// Small delay to ensure the element is rendered and transitions are complete
			const timer = setTimeout(() => {
				textareaRef.current?.focus();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [resume]);

	// Fetch session data to check if session exists (only for existing sessions)
	const { session } = useSession(resume ? sessionId : null);

	// Fetch messages from SWR for existing sessions
	const { messages: swrMessages, mutate: invalidateMessages } = useMessages(
		resume ? sessionId : null,
	);

	React.useEffect(() => {
		if (resume && sessionId) {
			invalidateMessages();
		}
	}, [resume, sessionId, invalidateMessages]);

	// Use refs to store the latest selection values for use in fetch
	// This ensures sendMessage always uses current values even if useChat caches the transport
	const selectionRef = React.useRef({
		workspaceId: localSelectedWorkspaceId,
		agentId: localSelectedAgentId,
		resume,
	});

	// Keep refs in sync with state
	React.useEffect(() => {
		selectionRef.current = {
			workspaceId: localSelectedWorkspaceId,
			agentId: localSelectedAgentId,
			resume,
		};
	}, [localSelectedWorkspaceId, localSelectedAgentId, resume]);

	// Create transport with custom fetch that always uses latest selection values
	const transport = React.useMemo(
		() =>
			new DefaultChatTransport({
				api: `${getApiBase()}/chat`,
				// Use custom fetch to inject latest workspace/agent IDs for new sessions
				fetch: async (url, options) => {
					const { resume, workspaceId, agentId } = selectionRef.current;

					// Only modify body for new sessions
					if (!resume && options?.body) {
						const body = JSON.parse(options.body as string);
						body.workspaceId = workspaceId;
						body.agentId = agentId;

						const response = await fetch(url, {
							...options,
							body: JSON.stringify(body),
						});

						// If we got a 200 response, the server has acknowledged the session
						if (response.ok) {
							// Call the callback to notify that the session was created
							if (onSessionCreated && workspaceId && agentId) {
								onSessionCreated(sessionId, workspaceId, agentId);
							}
						}

						return response;
					}

					return fetch(url, options);
				},
			}),
		[onSessionCreated, sessionId],
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
		id: sessionId,
		resume,
		onError: handleChatError,
		messages: initialMessages,
		onFinish: onChatComplete,
	});

	// Sync SWR messages with useChat when they change (after refetch)
	// This ensures that when we invalidate the cache and get fresh messages,
	// the chat UI updates to show them instead of stale initialMessages
	const prevSwrMessagesRef = React.useRef<UIMessage[]>([]);

	React.useEffect(() => {
		if (resume && swrMessages.length > 0) {
			// Check if the last SWR message exists in useChat messages
			// If it does, useChat is already up-to-date (or ahead with streaming content)
			const lastSwrMessage = swrMessages[swrMessages.length - 1];
			const lastSwrMessageExistsInUseChat = messages.some(
				(msg) => msg.id === lastSwrMessage.id,
			);

			// Only sync if:
			// 1. SWR messages have changed (different length or IDs)
			// 2. AND the last SWR message doesn't exist in useChat messages yet
			//    (to avoid clobbering streaming messages)
			const swrMessagesChanged =
				swrMessages.length !== prevSwrMessagesRef.current.length ||
				swrMessages.some(
					(msg, i) => msg.id !== prevSwrMessagesRef.current[i]?.id,
				);

			if (swrMessagesChanged && !lastSwrMessageExistsInUseChat) {
				prevSwrMessagesRef.current = swrMessages;

				// Extra safety: deduplicate before setting (should already be deduped by useMessages hook)
				const seen = new Set<string>();
				const dedupedMessages = swrMessages.filter((msg) => {
					if (seen.has(msg.id)) {
						console.warn(`[ChatPanel] Duplicate message ID in sync: ${msg.id}`);
						return false;
					}
					seen.add(msg.id);
					return true;
				});

				setMessages(dedupedMessages);
			}
		}
	}, [resume, swrMessages, messages, setMessages]);

	// Derive loading state from chat status
	const isLoading = chatStatus === "streaming" || chatStatus === "submitted";
	const hasError = chatStatus === "error";

	// Extract the current plan from deferred messages for consistent UI state
	const currentPlan = React.useMemo(
		() => extractLatestPlan(messages),
		[messages],
	);

	// Handle form submission - memoized to prevent PromptInput re-renders
	const handleSubmit = React.useCallback(
		async (message: PromptInputMessage, e: React.FormEvent) => {
			// Validate selections for new sessions
			e.preventDefault();
			const messageText = message.text;
			if (!messageText?.trim() || isLoading) return;

			// Validate selections for new sessions
			if (!resume && (!localSelectedWorkspaceId || !localSelectedAgentId)) {
				return;
			}

			try {
				await sendMessage({
					text: messageText,
					files: message.files || [],
				});
			} catch (err) {
				console.error("Failed to send message:", err);
			}
		},
		[
			isLoading,
			resume,
			localSelectedWorkspaceId,
			localSelectedAgentId,
			sendMessage,
		],
	);

	const handleCopy = React.useCallback((content: string) => {
		navigator.clipboard.writeText(content);
	}, []);

	return (
		<div
			className={cn(
				"relative flex flex-col h-full bg-background transition-all duration-300 ease-in-out",
				className,
			)}
		>
			{/* Error messages and status - always at top */}
			<div className="shrink-0">
				{/* Session status header - shows when not ready or running */}
				{session &&
					session.status !== SessionStatusConstants.READY &&
					session.status !== SessionStatusConstants.RUNNING && (
						<div
							className={cn(
								"flex items-center gap-2 py-3 px-4 border-b",
								session.status === SessionStatusConstants.ERROR ||
									session.status === SessionStatusConstants.REMOVING
									? "bg-destructive/10 border-destructive/20"
									: session.status === SessionStatusConstants.STOPPED
										? "bg-yellow-500/10 border-yellow-500/20"
										: session.status === SessionStatusConstants.REMOVED
											? "bg-muted/30 border-border"
											: "bg-muted/50 border-border",
							)}
						>
							{getSessionStatusIndicator(session)}
							<span
								className={cn(
									"text-sm font-medium",
									session.status === SessionStatusConstants.ERROR ||
										session.status === SessionStatusConstants.REMOVING
										? "text-destructive"
										: session.status === SessionStatusConstants.STOPPED
											? "text-yellow-600 dark:text-yellow-500"
											: "text-muted-foreground",
								)}
							>
								{getSessionHoverText(session)}
							</span>
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
			</div>

			{/* Content area - centered when new/empty, normal flow otherwise */}
			<div
				className={cn(
					"flex flex-col flex-1 overflow-hidden",
					messages.length === 0 && "justify-center",
				)}
			>
				{/* Welcome UI - header and selectors for new sessions */}
				<ChatNewContent
					show={!resume && messages.length === 0}
					initialWorkspaceId={initialWorkspaceId}
					onWorkspaceChange={setLocalSelectedWorkspaceId}
					onAgentChange={setLocalSelectedAgentId}
				/>

				{/* Conversation area */}
				<ChatConversation
					messages={messages}
					messagesLoading={false}
					isChatActive={isLoading}
					onCopy={handleCopy}
				/>
			</div>

			{/* Input area for non-new sessions - outside centered container */}
			<ChatPlanQueue plan={currentPlan}>
				<div
					className={cn(
						"shrink-0 transition-all duration-300 ease-in-out bg-background relative z-10",
						"px-4 pb-4 max-w-3xl mx-auto w-full",
					)}
				>
					{/* Expanded queue panel - shows above input when expanded */}
					{currentPlan && <QueuePanel plan={currentPlan} />}

					<PromptInputWithHistory
						ref={textareaRef}
						sessionId={sessionId}
						onSubmit={handleSubmit}
						status={chatStatus}
						isLocked={
							session?.commitStatus === CommitStatus.PENDING ||
							session?.commitStatus === CommitStatus.COMMITTING
						}
						placeholder={
							session?.commitStatus === CommitStatus.PENDING ||
							session?.commitStatus === CommitStatus.COMMITTING
								? "Chat disabled during commit..."
								: "Type a message..."
						}
						textareaClassName={cn(
							"transition-all duration-300",
							"min-h-[60px]",
						)}
						submitDisabled={false}
						queueButton={<QueueButton />}
					/>
				</div>
			</ChatPlanQueue>

			{/* Session ID - subtle display in lower right */}
			<div className="absolute bottom-2 right-2 select-text">
				<span className="text-[10px] text-muted-foreground/50 font-mono">
					{sessionId}
				</span>
			</div>
		</div>
	);
}
