import { ChevronUpIcon, HistoryIcon, PinIcon } from "lucide-react";
import { memo, type RefObject, useEffect, useRef } from "react";
import { MAX_VISIBLE_HISTORY } from "@/lib/hooks/use-prompt-history";
import { cn } from "@/lib/utils";

export interface PromptHistoryDropdownProps {
	/** Full history array */
	history: string[];
	/** Pinned prompts array */
	pinnedPrompts: string[];
	/** Currently selected index (-1 = none) */
	historyIndex: number;
	/** Whether the selected item is in the pinned section */
	isPinnedSelection: boolean;
	/** Whether dropdown is open */
	isHistoryOpen: boolean;
	/** Set the history index (for hover) */
	setHistoryIndex: (index: number, isPinned: boolean) => void;
	/** Select a history item */
	onSelectHistory: (prompt: string) => void;
	/** Pin a prompt */
	pinPrompt: (prompt: string) => void;
	/** Unpin a prompt */
	unpinPrompt: (prompt: string) => void;
	/** Check if a prompt is pinned */
	isPinned: (prompt: string) => boolean;
	/** Ref to the textarea (for click-outside detection) */
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** Close the dropdown */
	closeHistory: () => void;
}

export const PromptHistoryDropdown = memo(function PromptHistoryDropdown({
	history: fullHistory,
	pinnedPrompts,
	historyIndex,
	isPinnedSelection,
	isHistoryOpen,
	setHistoryIndex,
	onSelectHistory,
	pinPrompt,
	unpinPrompt,
	isPinned,
	textareaRef,
	closeHistory,
}: PromptHistoryDropdownProps) {
	const dropdownRef = useRef<HTMLDivElement>(null);

	// Only show the most recent prompts
	const history = fullHistory.slice(0, MAX_VISIBLE_HISTORY);

	// Scroll selected item into view
	useEffect(() => {
		if (isHistoryOpen && historyIndex >= 0 && dropdownRef.current) {
			const selector = isPinnedSelection
				? `[data-pinned-index="${historyIndex}"]`
				: `[data-index="${historyIndex}"]`;
			const selectedItem = dropdownRef.current.querySelector(selector);
			if (selectedItem && typeof selectedItem.scrollIntoView === "function") {
				selectedItem.scrollIntoView({ block: "nearest" });
			}
		}
	}, [isHistoryOpen, historyIndex, isPinnedSelection]);

	// Close dropdown when clicking outside
	useEffect(() => {
		if (!isHistoryOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			if (
				dropdownRef.current &&
				!dropdownRef.current.contains(e.target as Node) &&
				textareaRef.current &&
				!textareaRef.current.contains(e.target as Node)
			) {
				closeHistory();
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [isHistoryOpen, textareaRef, closeHistory]);

	if (!isHistoryOpen || (history.length === 0 && pinnedPrompts.length === 0)) {
		return null;
	}

	return (
		<div
			ref={dropdownRef}
			className="absolute bottom-full left-0 right-0 z-50 mb-1 flex max-h-96 flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
		>
			<div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-popover px-3 py-2">
				<HistoryIcon className="h-4 w-4 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					Prompt history
				</span>
				<span className="ml-auto text-xs text-muted-foreground">
					<ChevronUpIcon className="inline h-3 w-3" />
					<span className="mx-0.5">/</span>
					<ChevronUpIcon className="inline h-3 w-3 rotate-180" />
					to navigate
				</span>
			</div>

			{/* Recent history section - scrollable */}
			{history.length > 0 && (
				<div className="flex flex-1 flex-col overflow-hidden">
					{pinnedPrompts.length > 0 && (
						<div className="px-3 py-1.5">
							<span className="text-xs font-medium text-muted-foreground">
								Recent
							</span>
						</div>
					)}
					<div className="flex flex-col-reverse overflow-y-auto py-1">
						{history.map((prompt, index) => (
							<div
								key={prompt}
								data-index={index}
								className={cn(
									"group relative flex items-start gap-2 px-3 py-2 transition-colors",
									"hover:bg-accent",
									!isPinnedSelection && index === historyIndex && "bg-accent",
								)}
							>
								<button
									type="button"
									onClick={() => onSelectHistory(prompt)}
									onMouseEnter={() => setHistoryIndex(index, false)}
									className="flex-1 text-left text-sm"
								>
									<span className="line-clamp-2 break-words">{prompt}</span>
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										if (isPinned(prompt)) {
											unpinPrompt(prompt);
										} else {
											pinPrompt(prompt);
										}
									}}
									className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
									title={isPinned(prompt) ? "Unpin" : "Pin"}
								>
									<PinIcon
										className={cn(
											"h-3.5 w-3.5 text-muted-foreground hover:text-foreground",
											isPinned(prompt) && "fill-current",
										)}
									/>
								</button>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Pinned section - always visible at bottom, no scrolling */}
			{pinnedPrompts.length > 0 && (
				<div className="border-t border-border bg-muted/30">
					<div className="px-3 py-1.5">
						<span className="text-xs font-medium text-muted-foreground">
							Pinned
						</span>
					</div>
					<div className="flex flex-col-reverse pb-1">
						{pinnedPrompts.map((prompt, index) => (
							<div
								key={prompt}
								data-pinned-index={index}
								className={cn(
									"group relative flex items-start gap-2 px-3 py-2 transition-colors",
									"hover:bg-accent",
									isPinnedSelection && index === historyIndex && "bg-accent",
								)}
							>
								<button
									type="button"
									onClick={() => onSelectHistory(prompt)}
									onMouseEnter={() => setHistoryIndex(index, true)}
									className="flex-1 text-left text-sm"
								>
									<span className="line-clamp-2 break-words">{prompt}</span>
								</button>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										unpinPrompt(prompt);
									}}
									className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
									title="Unpin"
								>
									<PinIcon className="h-3.5 w-3.5 fill-current text-muted-foreground hover:text-foreground" />
								</button>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
});
