"use client";

import * as React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Message container
interface MessageProps extends React.HTMLAttributes<HTMLDivElement> {
	from?: "user" | "assistant" | "system";
}

export function Message({
	from = "assistant",
	className,
	children,
	...props
}: MessageProps) {
	return (
		<div
			className={cn(
				"group flex gap-3 w-full",
				from === "user" && "flex-row-reverse",
				className,
			)}
			data-role={from}
			{...props}
		>
			{children}
		</div>
	);
}

// Message content wrapper
export function MessageContent({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("flex flex-col gap-2 max-w-[85%]", className)}
			{...props}
		>
			{children}
		</div>
	);
}

// Message response with markdown rendering
interface MessageResponseProps extends React.HTMLAttributes<HTMLDivElement> {
	children?: string;
}

export function MessageResponse({
	children,
	className,
	...props
}: MessageResponseProps) {
	const role = React.useContext(MessageRoleContext);

	return (
		<div
			className={cn(
				"rounded-lg px-4 py-3 text-sm",
				role === "user"
					? "bg-primary text-primary-foreground"
					: "bg-muted text-foreground",
				className,
			)}
			{...props}
		>
			{typeof children === "string" ? (
				<Markdown
					remarkPlugins={[remarkGfm]}
					components={{
						p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
						code: ({ children, className }) => {
							const isInline = !className;
							return isInline ? (
								<code className="bg-background/50 px-1 py-0.5 rounded text-xs font-mono">
									{children}
								</code>
							) : (
								<code
									className={cn(
										"block bg-background/50 p-2 rounded text-xs font-mono overflow-x-auto",
										className,
									)}
								>
									{children}
								</code>
							);
						},
						pre: ({ children }) => (
							<pre className="bg-background/50 p-3 rounded-lg overflow-x-auto my-2">
								{children}
							</pre>
						),
					}}
				>
					{children}
				</Markdown>
			) : (
				children
			)}
		</div>
	);
}

// Context for passing role to nested components
const MessageRoleContext = React.createContext<"user" | "assistant" | "system">(
	"assistant",
);

export function MessageRoleProvider({
	role,
	children,
}: {
	role: "user" | "assistant" | "system";
	children: React.ReactNode;
}) {
	return (
		<MessageRoleContext.Provider value={role}>
			{children}
		</MessageRoleContext.Provider>
	);
}

// Message actions container
export function MessageActions({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<TooltipProvider>
			<div
				className={cn(
					"flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity",
					className,
				)}
				{...props}
			>
				{children}
			</div>
		</TooltipProvider>
	);
}

// Individual action button
interface MessageActionProps extends React.ComponentProps<typeof Button> {
	label?: string;
	tooltip?: string;
}

export function MessageAction({
	label,
	tooltip,
	className,
	children,
	...props
}: MessageActionProps) {
	const button = (
		<Button
			variant="ghost"
			size="icon"
			className={cn("size-7", className)}
			{...props}
		>
			{children}
			{label && <span className="sr-only">{label}</span>}
		</Button>
	);

	if (tooltip || label) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{button}</TooltipTrigger>
				<TooltipContent side="top" className="text-xs">
					{tooltip || label}
				</TooltipContent>
			</Tooltip>
		);
	}

	return button;
}
