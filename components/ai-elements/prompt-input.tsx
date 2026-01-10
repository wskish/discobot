"use client";

import { Loader2, Send, Square } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface PromptInputMessage {
	text?: string;
	files?: File[];
}

interface PromptInputContextValue {
	input: string;
	setInput: (value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	status: "ready" | "submitted" | "streaming" | "error";
}

const PromptInputContext = React.createContext<PromptInputContextValue | null>(
	null,
);

function usePromptInput() {
	const context = React.useContext(PromptInputContext);
	if (!context) {
		throw new Error("PromptInput components must be used within a PromptInput");
	}
	return context;
}

// Main input container
interface InputProps
	extends Omit<
		React.FormHTMLAttributes<HTMLFormElement>,
		"onSubmit" | "onChange"
	> {
	onSubmit?: (message: PromptInputMessage, e: React.FormEvent) => void;
	value?: string;
	onChange?: (value: string) => void;
	status?: "ready" | "submitted" | "streaming" | "error";
}

export function Input({
	onSubmit,
	value: controlledValue,
	onChange: controlledOnChange,
	status = "ready",
	className,
	children,
	...props
}: InputProps) {
	const [uncontrolledInput, setUncontrolledInput] = React.useState("");

	const input = controlledValue ?? uncontrolledInput;
	const setInput = controlledOnChange ?? setUncontrolledInput;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (input.trim() && status === "ready") {
			onSubmit?.({ text: input }, e);
		}
	};

	return (
		<PromptInputContext.Provider
			value={{ input, setInput, handleSubmit, status }}
		>
			<form
				onSubmit={handleSubmit}
				className={cn(
					"relative flex flex-col gap-2 rounded-lg border border-input bg-background p-2",
					className,
				)}
				{...props}
			>
				{children}
			</form>
		</PromptInputContext.Provider>
	);
}

// Textarea component
interface PromptInputTextareaProps
	extends Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> {
	value?: string;
	onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

export function PromptInputTextarea({
	className,
	value: propValue,
	onChange: propOnChange,
	onKeyDown,
	...props
}: PromptInputTextareaProps) {
	const { input, setInput, handleSubmit, status } = usePromptInput();

	const value = propValue ?? input;
	const handleChange =
		propOnChange ??
		((e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value));

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e as unknown as React.FormEvent);
		}
		onKeyDown?.(e);
	};

	return (
		<Textarea
			value={value}
			onChange={handleChange}
			onKeyDown={handleKeyDown}
			disabled={status !== "ready"}
			className={cn(
				"min-h-[60px] max-h-[200px] resize-none border-0 p-2 focus-visible:ring-0 focus-visible:ring-offset-0",
				className,
			)}
			{...props}
		/>
	);
}

// Submit button
interface PromptInputSubmitProps extends React.ComponentProps<typeof Button> {
	status?: "ready" | "submitted" | "streaming" | "error";
}

export function PromptInputSubmit({
	status: propStatus,
	className,
	children,
	...props
}: PromptInputSubmitProps) {
	const context = usePromptInput();
	const status = propStatus ?? context.status;
	const { input } = context;

	const isLoading = status === "submitted" || status === "streaming";
	const isDisabled =
		(!input.trim() && status === "ready") || status === "error";

	return (
		<Button
			type="submit"
			size="icon"
			disabled={isDisabled}
			className={cn("shrink-0", className)}
			{...props}
		>
			{children ||
				(isLoading ? (
					status === "streaming" ? (
						<Square className="size-4 fill-current" />
					) : (
						<Loader2 className="size-4 animate-spin" />
					)
				) : (
					<Send className="size-4" />
				))}
		</Button>
	);
}

// Toolbar container
export function PromptInputToolbar({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("flex items-center justify-between gap-2", className)}
			{...props}
		>
			{children}
		</div>
	);
}

// Tools container (left side of toolbar)
export function PromptInputTools({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={cn("flex items-center gap-1", className)} {...props}>
			{children}
		</div>
	);
}

// Generic button for tools
export function PromptInputButton({
	className,
	...props
}: React.ComponentProps<typeof Button>) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className={cn("size-8", className)}
			{...props}
		/>
	);
}

// Body container for textarea
export function PromptInputBody({
	className,
	children,
	...props
}: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={cn("flex-1", className)} {...props}>
			{children}
		</div>
	);
}
