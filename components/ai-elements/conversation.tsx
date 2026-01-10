"use client";

import { ArrowDown, MessageSquare } from "lucide-react";
import type * as React from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Conversation container with auto-scroll
export function Conversation({
	children,
	className,
	...props
}: React.ComponentProps<typeof StickToBottom>) {
	return (
		<StickToBottom
			className={cn("relative flex-1 overflow-hidden", className)}
			resize="smooth"
			initial="smooth"
			{...props}
		>
			{children}
		</StickToBottom>
	);
}

// Scrollable content area
export function ConversationContent({
	children,
	className,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<StickToBottom.Content
			className={cn("flex flex-col gap-4 p-4 overflow-y-auto", className)}
			{...props}
		>
			{children}
		</StickToBottom.Content>
	);
}

// Empty state when no messages
interface ConversationEmptyStateProps
	extends React.HTMLAttributes<HTMLDivElement> {
	icon?: React.ReactNode;
	title?: string;
	description?: string;
}

export function ConversationEmptyState({
	icon,
	title = "Start a conversation",
	description = "Messages will appear here as the conversation progresses.",
	className,
	children,
	...props
}: ConversationEmptyStateProps) {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground p-8",
				className,
			)}
			{...props}
		>
			{icon || <MessageSquare className="size-12 opacity-50" />}
			{title && <h3 className="text-lg font-medium">{title}</h3>}
			{description && <p className="text-sm max-w-sm">{description}</p>}
			{children}
		</div>
	);
}

// Scroll to bottom button
export function ConversationScrollButton({
	className,
	...props
}: React.ComponentProps<typeof Button>) {
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();

	if (isAtBottom) return null;

	return (
		<Button
			variant="secondary"
			size="icon"
			className={cn(
				"absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-lg z-10",
				className,
			)}
			onClick={() => scrollToBottom()}
			{...props}
		>
			<ArrowDown className="size-4" />
		</Button>
	);
}
