import type { UIMessage } from "ai";
import { Copy, Loader2, MessageSquare } from "lucide-react";
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
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { useLazyRender } from "@/lib/hooks/use-lazy-render";
import { cn } from "@/lib/utils";
import { MessagePart } from "./message-parts";

interface ChatConversationProps {
	/** Messages from useChat (consolidated list) */
	messages: UIMessage[];
	/** Whether messages are currently loading from the API */
	messagesLoading: boolean;
	/** Whether the chat is currently streaming or processing */
	isChatActive: boolean;
	/** Callback to copy message content */
	onCopy: (content: string) => void;
}

// Helper to extract text content from AI SDK message parts
function getMessageText(message: UIMessage): string {
	return message.parts
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
}

// Memoized message item to prevent re-renders when messages array updates
interface MessageItemProps {
	message: UIMessage;
	onCopy: (text: string) => void;
	isStreaming?: boolean;
}

const MessageItem = React.memo(function MessageItem({
	message,
	onCopy,
	isStreaming = false,
}: MessageItemProps) {
	const textContent = React.useMemo(() => getMessageText(message), [message]);

	return (
		<Message from={message.role}>
			<MessageContent>
				{/* Render message parts in order */}
				{message.parts.map((part, partIdx) => (
					<MessagePart
						key={`${message.id}-part-${partIdx}`}
						message={message}
						partIdx={partIdx}
						part={part}
						isStreaming={isStreaming}
					/>
				))}
				{message.role === "assistant" && (
					<MessageActions>
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
	isStreaming = false,
	estimatedHeight = 100,
}: LazyMessageItemProps) {
	const [ref, hasBeenVisible] = useLazyRender(LAZY_OBSERVER_OPTIONS);

	return (
		<div ref={ref}>
			{hasBeenVisible ? (
				<MessageItem
					message={message}
					onCopy={onCopy}
					isStreaming={isStreaming}
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

/**
 * ChatConversation - Renders the conversation list with messages
 * Shows loading states, empty state, and streaming indicators
 */
export function ChatConversation({
	messages,
	messagesLoading,
	isChatActive,
	onCopy,
}: ChatConversationProps) {
	// Show loading state when fetching messages
	if (messagesLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<Conversation
			className={cn(
				"transition-all duration-300 ease-in-out",
				messages.length === 0
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
					<div className="max-w-2xl mx-auto w-full space-y-4">
						{messages.map((message, index) => {
							// Render last few messages immediately (they're likely visible)
							// Lazy-render older messages to improve initial load performance
							const isRecentMessage = index >= messages.length - 3;
							// Only the last message can be streaming
							const isThisMessageStreaming =
								isChatActive && index === messages.length - 1;

							return isRecentMessage ? (
								<MessageItem
									key={message.id}
									message={message}
									onCopy={onCopy}
									isStreaming={isThisMessageStreaming}
								/>
							) : (
								<LazyMessageItem
									key={message.id}
									message={message}
									onCopy={onCopy}
									isStreaming={isThisMessageStreaming}
									estimatedHeight={message.role === "user" ? 80 : 150}
								/>
							);
						})}
						{/* Show shimmer status when waiting for assistant response */}
						{isChatActive && (
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
	);
}
