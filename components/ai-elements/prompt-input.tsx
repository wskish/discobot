"use client";

import {
	ChevronUp,
	History,
	Loader2,
	Paperclip,
	Send,
	Square,
	X,
} from "lucide-react";
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
	// History support
	history: string[];
	historyIndex: number;
	setHistoryIndex: (index: number) => void;
	isHistoryOpen: boolean;
	setIsHistoryOpen: (open: boolean) => void;
	onSelectHistory: (prompt: string) => void;
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

// Helper to get/set history from localStorage
const HISTORY_KEY = "octobot-prompt-history";
const MAX_HISTORY_SIZE = 100;

function loadHistory(): string[] {
	if (typeof window === "undefined") return [];
	try {
		const stored = localStorage.getItem(HISTORY_KEY);
		if (stored) {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return parsed.filter((item) => typeof item === "string");
			}
		}
	} catch {
		// Ignore parse errors
	}
	return [];
}

function saveHistoryToStorage(history: string[]): void {
	if (typeof window === "undefined") return;
	try {
		const trimmed = history.slice(0, MAX_HISTORY_SIZE);
		localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
	} catch {
		// Ignore storage errors
	}
}

// Main input container
interface InputProps
	extends Omit<
		React.FormHTMLAttributes<HTMLFormElement>,
		"onSubmit" | "onChange"
	> {
	onSubmit?: (message: PromptInputMessage, e: React.FormEvent) => void;
	status?: "ready" | "submitted" | "streaming" | "error";
	// Session ID for draft persistence (localStorage, keyed by session)
	sessionId?: string | null;
}

// Helper to get/set draft from localStorage (per session ID, persists across browser sessions)
const DRAFT_PREFIX = "octobot-prompt-draft-";

function getDraft(sessionId: string | null | undefined): string {
	if (typeof window === "undefined" || !sessionId) return "";
	try {
		return localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`) || "";
	} catch {
		return "";
	}
}

function saveDraft(sessionId: string | null | undefined, value: string): void {
	if (typeof window === "undefined" || !sessionId) return;
	try {
		if (value) {
			localStorage.setItem(`${DRAFT_PREFIX}${sessionId}`, value);
		} else {
			localStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`);
		}
	} catch {
		// Ignore storage errors
	}
}

// Helper to merge new files with existing FileList
function mergeFiles(existing: FileList | null, newFiles: File[]): FileList {
	const dt = new DataTransfer();
	if (existing) {
		for (const f of existing) {
			dt.items.add(f);
		}
	}
	for (const f of newFiles) {
		dt.items.add(f);
	}
	return dt.files;
}

// Filter to only image files for paste/drop
function filterImageFiles(files: FileList | File[]): File[] {
	const result: File[] = [];
	for (const file of files) {
		if (file.type.startsWith("image/")) {
			result.push(file);
		}
	}
	return result;
}

export const Input = React.memo(function Input({
	onSubmit,
	status = "ready",
	sessionId,
	className,
	children,
	...props
}: InputProps) {
	// All state is managed internally to prevent parent re-renders
	const [input, setInputState] = React.useState(() => getDraft(sessionId));
	const [files, setFiles] = React.useState<FileList | null>(null);
	const [history, setHistory] = React.useState<string[]>(() => loadHistory());
	const [historyIndex, setHistoryIndex] = React.useState(-1);
	const [isHistoryOpen, setIsHistoryOpen] = React.useState(false);
	const [isDragging, setIsDragging] = React.useState(false);

	// Track sessionId changes to load correct draft
	const prevSessionIdRef = React.useRef(sessionId);
	React.useEffect(() => {
		if (prevSessionIdRef.current !== sessionId) {
			prevSessionIdRef.current = sessionId;
			setInputState(getDraft(sessionId));
		}
	}, [sessionId]);

	// Wrap setInput to also persist to sessionStorage
	const setInput = React.useCallback(
		(value: string) => {
			setInputState(value);
			saveDraft(sessionId, value);
		},
		[sessionId],
	);

	const handleSelectHistory = React.useCallback(
		(prompt: string) => {
			setInput(prompt);
			setIsHistoryOpen(false);
			setHistoryIndex(-1);
		},
		[setInput],
	);

	// Add prompt to history (called on successful submit)
	const addToHistory = React.useCallback((prompt: string) => {
		if (!prompt.trim()) return;
		setHistory((prev) => {
			if (prev.includes(prompt)) return prev;
			const updated = [prompt, ...prev].slice(0, MAX_HISTORY_SIZE);
			saveHistoryToStorage(updated);
			return updated;
		});
	}, []);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if ((input.trim() || files) && status === "ready") {
			const messageText = input;
			onSubmit?.({ text: messageText, files: files ?? undefined }, e);
			// Add to history and clear input
			addToHistory(messageText);
			setInput("");
			setFiles(null);
			setIsHistoryOpen(false);
			setHistoryIndex(-1);
		}
	};

	// Drag and drop handlers
	const handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (status !== "ready") return;
		setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the form entirely
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
			setIsDragging(false);
		}
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragging(false);
		if (status !== "ready") return;

		const droppedFiles = e.dataTransfer?.files;
		if (droppedFiles && droppedFiles.length > 0) {
			const imageFiles = filterImageFiles(droppedFiles);
			if (imageFiles.length > 0) {
				setFiles(mergeFiles(files, imageFiles));
			}
		}
	};

	return (
		<PromptInputContext.Provider
			value={{
				input,
				setInput,
				files,
				setFiles,
				handleSubmit,
				status,
				history,
				historyIndex,
				setHistoryIndex,
				isHistoryOpen,
				setIsHistoryOpen,
				onSelectHistory: handleSelectHistory,
			}}
		>
			<form
				onSubmit={handleSubmit}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				className={cn(
					"relative flex flex-col gap-2 rounded-lg border border-input bg-background p-2 transition-colors",
					isDragging && "border-primary border-dashed bg-primary/5",
					className,
				)}
				{...props}
			>
				{children}
			</form>
		</PromptInputContext.Provider>
	);
});

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
	onPaste: propOnPaste,
	...props
}: PromptInputTextareaProps) {
	const {
		input,
		setInput,
		files,
		setFiles,
		handleSubmit,
		status,
		history,
		historyIndex,
		setHistoryIndex,
		isHistoryOpen,
		setIsHistoryOpen,
		onSelectHistory,
	} = usePromptInput();
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);

	const value = propValue ?? input;
	const handleChange =
		propOnChange ??
		((e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value));

	// Handle paste to capture images from clipboard
	const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const items = e.clipboardData?.items;
		if (!items || status !== "ready") {
			propOnPaste?.(e);
			return;
		}

		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		if (imageFiles.length > 0) {
			// Don't prevent default if there's also text - let text paste through
			const hasText = Array.from(items).some(
				(item) => item.kind === "string" && item.type === "text/plain",
			);
			if (!hasText) {
				e.preventDefault();
			}
			setFiles(mergeFiles(files, imageFiles));
		}

		propOnPaste?.(e);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Handle Enter to select from history (must come before submit check)
		if (
			e.key === "Enter" &&
			!e.shiftKey &&
			isHistoryOpen &&
			historyIndex >= 0
		) {
			e.preventDefault();
			const selectedPrompt = history[historyIndex];
			if (selectedPrompt) {
				onSelectHistory(selectedPrompt);
			}
			return;
		}

		// Handle Enter to submit
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e as unknown as React.FormEvent);
			return;
		}

		// Handle Escape to close history dropdown
		if (e.key === "Escape" && isHistoryOpen) {
			e.preventDefault();
			setIsHistoryOpen(false);
			setHistoryIndex(-1);
			return;
		}

		// Handle Up arrow for history navigation
		// Limit visible history to 5 items
		const visibleHistoryLength = Math.min(history.length, 5);
		if (e.key === "ArrowUp" && visibleHistoryLength > 0) {
			const textarea = textareaRef.current;
			const cursorPosition = textarea?.selectionStart ?? 0;

			// Only trigger history if cursor is at the start (position 0)
			if (cursorPosition === 0) {
				e.preventDefault();

				if (!isHistoryOpen) {
					// Open history dropdown and select bottom item (most recent, index 0 in data)
					setIsHistoryOpen(true);
					setHistoryIndex(0);
				} else {
					// Navigate up in the visual list (toward older items = higher index)
					// If at top of visual list (oldest visible), stay there
					if (historyIndex < visibleHistoryLength - 1) {
						setHistoryIndex(historyIndex + 1);
					}
				}
				return;
			}
		}

		// Handle Down arrow for history navigation
		if (e.key === "ArrowDown" && isHistoryOpen && visibleHistoryLength > 0) {
			e.preventDefault();
			// Navigate down in visual list (toward newer items = lower index)
			// If at bottom (most recent, index 0), close dropdown
			if (historyIndex <= 0) {
				setIsHistoryOpen(false);
				setHistoryIndex(-1);
			} else {
				setHistoryIndex(historyIndex - 1);
			}
			return;
		}

		onKeyDown?.(e);
	};

	return (
		<div className="relative">
			<Textarea
				ref={textareaRef}
				value={value}
				onChange={handleChange}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
				disabled={status !== "ready"}
				className={cn(
					"min-h-[60px] max-h-[200px] resize-none border-0 p-2 focus-visible:ring-0 focus-visible:ring-offset-0",
					className,
				)}
				{...props}
			/>
			<PromptHistoryDropdown />
		</div>
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

// Prompt history dropdown - shows previous prompts
const MAX_VISIBLE_HISTORY = 5;

function PromptHistoryDropdown() {
	const {
		history: fullHistory,
		historyIndex,
		isHistoryOpen,
		setIsHistoryOpen,
		setHistoryIndex,
		onSelectHistory,
	} = usePromptInput();
	const dropdownRef = React.useRef<HTMLDivElement>(null);

	// Only show the most recent prompts
	const history = fullHistory.slice(0, MAX_VISIBLE_HISTORY);

	// Scroll selected item into view
	React.useEffect(() => {
		if (isHistoryOpen && historyIndex >= 0 && dropdownRef.current) {
			const selectedItem = dropdownRef.current.querySelector(
				`[data-index="${historyIndex}"]`,
			);
			if (selectedItem) {
				selectedItem.scrollIntoView({ block: "nearest" });
			}
		}
	}, [isHistoryOpen, historyIndex]);

	// Close dropdown when clicking outside
	React.useEffect(() => {
		if (!isHistoryOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(e.target as Node)
			) {
				setIsHistoryOpen(false);
				setHistoryIndex(-1);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isHistoryOpen, setIsHistoryOpen, setHistoryIndex]);

	if (!isHistoryOpen || history.length === 0) return null;

	return (
		<div
			ref={dropdownRef}
			className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<History className="h-4 w-4 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					Recent prompts
				</span>
				<span className="ml-auto text-xs text-muted-foreground">
					<ChevronUp className="inline h-3 w-3" />
					<span className="mx-0.5">/</span>
					<ChevronUp className="inline h-3 w-3 rotate-180" />
					to navigate
				</span>
			</div>
			<div className="flex flex-col-reverse py-1">
				{history.map((prompt, index) => (
					<button
						key={prompt}
						type="button"
						data-index={index}
						onClick={() => onSelectHistory(prompt)}
						onMouseEnter={() => setHistoryIndex(index)}
						className={cn(
							"w-full px-3 py-2 text-left text-sm transition-colors",
							"hover:bg-accent",
							index === historyIndex && "bg-accent",
						)}
					>
						<span className="line-clamp-2 break-words">{prompt}</span>
					</button>
				))}
			</div>
		</div>
	);
}
