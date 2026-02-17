import { Paperclip } from "lucide-react";
import * as React from "react";
import {
	Attachment,
	AttachmentPreview,
	AttachmentRemove,
	Attachments,
} from "@/components/ai-elements/attachments";
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
import { PromptHistoryDropdown } from "@/components/ide/prompt-history-dropdown";
import { usePromptHistory } from "@/lib/hooks/use-prompt-history";
import { cn } from "@/lib/utils";

interface PromptInputWithHistoryProps {
	/** Session ID for persisting history */
	sessionId: string | null;
	/** Whether this is a new (unsaved) session */
	isNewSession?: boolean;
	/** Submit handler */
	onSubmit: (message: PromptInputMessage, e: React.FormEvent) => void;
	/** Stop handler (called when stop button is clicked during streaming) */
	onStop?: () => void;
	/** Input status */
	status: "ready" | "streaming" | "submitted" | "error";
	/** Whether input is locked */
	isLocked?: boolean;
	/** Placeholder text */
	placeholder?: string;
	/** Additional CSS classes for the container */
	className?: string;
	/** Additional CSS classes for the textarea */
	textareaClassName?: string;
	/** Whether submit button should be disabled */
	submitDisabled?: boolean;
	/** Optional queue button to render in footer (before submit button) */
	queueButton?: React.ReactNode;
	/** Optional model selector to render in tools (after attachment button) */
	modelSelector?: React.ReactNode;
}

// Attachments preview component
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

/**
 * PromptInputWithHistory - Text input with prompt history dropdown
 * Encapsulates prompt history state and UI
 */
export const PromptInputWithHistory = React.memo(
	React.forwardRef<HTMLTextAreaElement, PromptInputWithHistoryProps>(
		function PromptInputWithHistory(
			{
				sessionId,
				isNewSession = false,
				onSubmit,
				onStop,
				status,
				isLocked = false,
				placeholder,
				className,
				textareaClassName,
				submitDisabled = false,
				queueButton,
				modelSelector,
			},
			ref,
		) {
			const internalRef = React.useRef<HTMLTextAreaElement>(null);
			const textareaRef =
				(ref as React.RefObject<HTMLTextAreaElement>) || internalRef;

			const {
				history,
				pinnedPrompts,
				historyIndex,
				isPinnedSelection,
				isHistoryOpen,
				setHistoryIndex,
				onSelectHistory,
				addToHistory,
				pinPrompt,
				unpinPrompt,
				isPinned,
				closeHistory,
				handleKeyDown: historyKeyDown,
			} = usePromptHistory({
				textareaRef,
				sessionId,
				isNewSession,
			});

			// Wrap handleSubmit to also add to history
			const wrappedHandleSubmit = React.useCallback(
				(message: PromptInputMessage, e: React.FormEvent) => {
					const text = message.text;
					onSubmit(message, e);
					// Add to history after submit
					if (text) {
						addToHistory(text);
					}
				},
				[onSubmit, addToHistory],
			);

			return (
				<div className={cn("relative", className)}>
					<PromptHistoryDropdown
						history={history}
						pinnedPrompts={pinnedPrompts}
						historyIndex={historyIndex}
						isPinnedSelection={isPinnedSelection}
						isHistoryOpen={isHistoryOpen}
						setHistoryIndex={setHistoryIndex}
						onSelectHistory={onSelectHistory}
						pinPrompt={pinPrompt}
						unpinPrompt={unpinPrompt}
						isPinned={isPinned}
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
							placeholder={placeholder}
							disabled={isLocked}
							onKeyDown={historyKeyDown}
							className={textareaClassName}
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
								{/* Model selector (if provided) */}
								{modelSelector}
							</PromptInputTools>
							<div className="flex items-center gap-2">
								{/* Queue button (if provided) */}
								{queueButton}
								<PromptInputSubmit
									status={status}
									onStop={onStop}
									disabled={isLocked || submitDisabled}
								/>
							</div>
						</PromptInputFooter>
					</PromptInput>
				</div>
			);
		},
	),
);
