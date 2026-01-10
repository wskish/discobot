"use client";

import { Loader2, Paperclip, Send, Square, X } from "lucide-react";
import Image from "next/image";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface FileUIPart {
	type: "file";
	filename: string;
	mediaType: string;
	url: string;
}

export interface PromptInputMessage {
	text?: string;
	files?: FileList | FileUIPart[];
}

interface PromptInputContextValue {
	input: string;
	setInput: (value: string) => void;
	files: FileList | null;
	setFiles: (files: FileList | null) => void;
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
	const [files, setFiles] = React.useState<FileList | null>(null);

	const input = controlledValue ?? uncontrolledInput;
	const setInput = controlledOnChange ?? setUncontrolledInput;

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if ((input.trim() || files) && status === "ready") {
			onSubmit?.({ text: input, files: files ?? undefined }, e);
			setFiles(null);
		}
	};

	return (
		<PromptInputContext.Provider
			value={{ input, setInput, files, setFiles, handleSubmit, status }}
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

// Attachment button for file uploads
interface PromptInputAttachmentProps
	extends Omit<React.ComponentProps<typeof Button>, "onClick"> {
	accept?: string;
	multiple?: boolean;
}

export function PromptInputAttachment({
	accept = "image/*,text/*,.pdf,.json,.md,.csv",
	multiple = true,
	className,
	children,
	...props
}: PromptInputAttachmentProps) {
	const { setFiles, status } = usePromptInput();
	const fileInputRef = React.useRef<HTMLInputElement>(null);

	const handleClick = () => {
		fileInputRef.current?.click();
	};

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files && e.target.files.length > 0) {
			setFiles(e.target.files);
		}
	};

	return (
		<>
			<input
				ref={fileInputRef}
				type="file"
				accept={accept}
				multiple={multiple}
				onChange={handleFileChange}
				className="sr-only"
				tabIndex={-1}
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				onClick={handleClick}
				disabled={status !== "ready"}
				className={cn("size-8", className)}
				aria-label="Attach files"
				{...props}
			>
				{children || <Paperclip className="size-4" />}
			</Button>
		</>
	);
}

// Attachment previews showing selected files
interface PromptInputAttachmentsPreviewProps
	extends React.HTMLAttributes<HTMLDivElement> {}

export function PromptInputAttachmentsPreview({
	className,
	...props
}: PromptInputAttachmentsPreviewProps) {
	const { files, setFiles } = usePromptInput();

	if (!files || files.length === 0) return null;

	const handleRemove = (indexToRemove: number) => {
		if (!files) return;

		const dt = new DataTransfer();
		for (let i = 0; i < files.length; i++) {
			if (i !== indexToRemove) {
				dt.items.add(files[i]);
			}
		}
		setFiles(dt.files.length > 0 ? dt.files : null);
	};

	const fileArray = Array.from(files);

	return (
		<div className={cn("flex flex-wrap gap-2 px-2 pb-1", className)} {...props}>
			{fileArray.map((file, index) => (
				<AttachmentPreviewItem
					key={`${file.name}-${file.size}-${index}`}
					file={file}
					onRemove={() => handleRemove(index)}
				/>
			))}
		</div>
	);
}

// Individual attachment preview item
interface AttachmentPreviewItemProps {
	file: File;
	onRemove: () => void;
}

function AttachmentPreviewItem({ file, onRemove }: AttachmentPreviewItemProps) {
	const [preview, setPreview] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (file.type.startsWith("image/")) {
			const url = URL.createObjectURL(file);
			setPreview(url);
			return () => URL.revokeObjectURL(url);
		}
	}, [file]);

	const isImage = file.type.startsWith("image/");

	return (
		<div className="group relative flex items-center gap-2 rounded-md border border-border bg-muted/50 px-2 py-1.5 text-sm">
			{isImage && preview ? (
				<div className="relative size-8 shrink-0">
					<Image
						src={preview}
						alt={file.name}
						fill
						className="rounded object-cover"
						unoptimized
					/>
				</div>
			) : (
				<Paperclip className="size-4 text-muted-foreground" />
			)}
			<span className="max-w-32 truncate text-muted-foreground">
				{file.name}
			</span>
			<button
				type="button"
				onClick={onRemove}
				className="ml-1 rounded-full p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
				aria-label={`Remove ${file.name}`}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}
