import {
	type KeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { usePreferences } from "./use-preferences";

// ============================================================================
// localStorage Helpers
// ============================================================================

const HISTORY_KEY = "discobot:prompt-history";
const PINNED_PREFERENCE_KEY = "prompts.pinned";
const DRAFT_PREFIX = "discobot-prompt-draft-";
const MAX_HISTORY_SIZE = 100;
export const MAX_VISIBLE_HISTORY = 20;

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

function getDraft(sessionId: string | null | undefined): string {
	if (typeof window === "undefined") return "";
	// Use "new" as the key for drafts without a session
	const key = sessionId || "new";
	try {
		return localStorage.getItem(`${DRAFT_PREFIX}${key}`) || "";
	} catch {
		return "";
	}
}

function saveDraft(sessionId: string | null | undefined, value: string): void {
	if (typeof window === "undefined") return;
	// Use "new" as the key for drafts without a session
	const key = sessionId || "new";
	try {
		if (value) {
			localStorage.setItem(`${DRAFT_PREFIX}${key}`, value);
		} else {
			localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
		}
	} catch {
		// Ignore storage errors
	}
}

function clearDraft(sessionId: string | null | undefined): void {
	if (typeof window === "undefined") return;
	const key = sessionId || "new";
	try {
		localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
	} catch {
		// Ignore storage errors
	}
}

// ============================================================================
// Hook
// ============================================================================

export interface UsePromptHistoryOptions {
	/** Ref to the textarea element */
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** Session ID for draft persistence */
	sessionId?: string | null;
}

export interface UsePromptHistoryReturn {
	/** Array of history prompts (most recent first) */
	history: string[];
	/** Array of pinned prompts */
	pinnedPrompts: string[];
	/** Currently selected history index (-1 = none, negative = pinned index, positive = history index) */
	historyIndex: number;
	/** Whether the selected item is in the pinned section */
	isPinnedSelection: boolean;
	/** Whether history dropdown is open */
	isHistoryOpen: boolean;
	/** Set the history index */
	setHistoryIndex: (index: number, isPinned: boolean) => void;
	/** Select a history item (sets textarea value and closes dropdown) */
	onSelectHistory: (prompt: string) => void;
	/** Add a prompt to history (call after successful submit) */
	addToHistory: (prompt: string) => void;
	/** Pin a prompt */
	pinPrompt: (prompt: string) => void;
	/** Unpin a prompt */
	unpinPrompt: (prompt: string) => void;
	/** Check if a prompt is pinned */
	isPinned: (prompt: string) => boolean;
	/** Close the history dropdown */
	closeHistory: () => void;
	/** Keyboard handler to attach to textarea's onKeyDown */
	handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	/** Get current textarea value */
	getValue: () => string;
}

export function usePromptHistory({
	textareaRef,
	sessionId,
}: UsePromptHistoryOptions): UsePromptHistoryReturn {
	// Load preferences to get pinned prompts
	const {
		getPreference,
		setPreference,
		isLoading: prefsLoading,
	} = usePreferences();

	// Parse pinned prompts from preferences
	const loadPinnedFromPreferences = useCallback((): string[] => {
		if (prefsLoading) return [];
		const stored = getPreference(PINNED_PREFERENCE_KEY);
		if (!stored) return [];
		try {
			const parsed = JSON.parse(stored);
			if (Array.isArray(parsed)) {
				return parsed.filter((item) => typeof item === "string");
			}
		} catch {
			// Ignore parse errors
		}
		return [];
	}, [getPreference, prefsLoading]);

	// History state
	const [history, setHistory] = useState<string[]>(() => loadHistory());
	const [pinnedPrompts, setPinnedPrompts] = useState<string[]>(() =>
		loadPinnedFromPreferences(),
	);
	const [historyIndex, setHistoryIndex] = useState(-1);
	const [isPinnedSelection, setIsPinnedSelection] = useState(false);
	const [isHistoryOpen, setIsHistoryOpen] = useState(false);

	// Sync pinned prompts from preferences when they change
	useEffect(() => {
		if (!prefsLoading) {
			const loaded = loadPinnedFromPreferences();
			setPinnedPrompts(loaded);
		}
	}, [prefsLoading, loadPinnedFromPreferences]);

	// Draft persistence refs (avoid re-renders on typing)
	const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const prevSessionRef = useRef(sessionId);

	// Load draft when sessionId changes
	useEffect(() => {
		if (prevSessionRef.current !== sessionId) {
			// When transitioning from null to a real session, clear the "new" draft
			if (prevSessionRef.current === null && sessionId !== null) {
				clearDraft(null);
			}
			prevSessionRef.current = sessionId;
			const draft = getDraft(sessionId);
			if (textareaRef.current) {
				textareaRef.current.value = draft;
			}
		}
	}, [sessionId, textareaRef]);

	// Save draft on input (debounced) - attach to textarea
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		const handleInput = () => {
			if (draftTimerRef.current) {
				clearTimeout(draftTimerRef.current);
			}
			draftTimerRef.current = setTimeout(() => {
				saveDraft(sessionId, textarea.value);
			}, 300);
		};

		textarea.addEventListener("input", handleInput);
		return () => {
			textarea.removeEventListener("input", handleInput);
			if (draftTimerRef.current) {
				clearTimeout(draftTimerRef.current);
			}
		};
	}, [sessionId, textareaRef]);

	// Load initial draft on mount
	useEffect(() => {
		if (textareaRef.current) {
			const draft = getDraft(sessionId);
			if (draft) {
				textareaRef.current.value = draft;
			}
		}
	}, [sessionId, textareaRef]);

	// Get current value
	const getValue = useCallback(() => {
		return textareaRef.current?.value ?? "";
	}, [textareaRef]);

	// Close history
	const closeHistory = useCallback(() => {
		setIsHistoryOpen(false);
		setHistoryIndex(-1);
		setIsPinnedSelection(false);
	}, []);

	// Set history index with pinned flag
	const setHistoryIndexWithPinned = useCallback(
		(index: number, isPinned: boolean) => {
			setHistoryIndex(index);
			setIsPinnedSelection(isPinned);
		},
		[],
	);

	// Select history item
	const onSelectHistory = useCallback(
		(prompt: string) => {
			if (textareaRef.current) {
				textareaRef.current.value = prompt;
				textareaRef.current.focus();
			}
			closeHistory();
		},
		[textareaRef, closeHistory],
	);

	// Add to history and clear draft
	const addToHistory = useCallback(
		(prompt: string) => {
			if (!prompt.trim()) return;
			setHistory((prev) => {
				// Don't add duplicates
				if (prev.includes(prompt)) return prev;
				const updated = [prompt, ...prev].slice(0, MAX_HISTORY_SIZE);
				saveHistoryToStorage(updated);
				return updated;
			});
			// Also clear draft after successful submit
			saveDraft(sessionId, "");
		},
		[sessionId],
	);

	// Pin a prompt
	const pinPrompt = useCallback(
		(prompt: string) => {
			if (!prompt.trim()) return;
			setPinnedPrompts((prev) => {
				// Don't add duplicates
				if (prev.includes(prompt)) return prev;
				const updated = [...prev, prompt];
				// Save to preferences API
				setPreference(PINNED_PREFERENCE_KEY, JSON.stringify(updated)).catch(
					(err) => {
						console.error("Failed to save pinned prompts:", err);
					},
				);
				return updated;
			});
		},
		[setPreference],
	);

	// Unpin a prompt
	const unpinPrompt = useCallback(
		(prompt: string) => {
			setPinnedPrompts((prev) => {
				const updated = prev.filter((p) => p !== prompt);
				// Save to preferences API
				setPreference(PINNED_PREFERENCE_KEY, JSON.stringify(updated)).catch(
					(err) => {
						console.error("Failed to save pinned prompts:", err);
					},
				);
				return updated;
			});
		},
		[setPreference],
	);

	// Check if a prompt is pinned
	const isPinned = useCallback(
		(prompt: string) => {
			return pinnedPrompts.includes(prompt);
		},
		[pinnedPrompts],
	);

	// Keyboard handler for history navigation
	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			const visibleHistoryLength = Math.min(
				history.length,
				MAX_VISIBLE_HISTORY,
			);
			const pinnedLength = pinnedPrompts.length;
			const hasItems = pinnedLength > 0 || visibleHistoryLength > 0;

			// Handle Enter to select from history
			if (
				e.key === "Enter" &&
				!e.shiftKey &&
				isHistoryOpen &&
				historyIndex >= 0
			) {
				e.preventDefault();
				const selectedPrompt = isPinnedSelection
					? pinnedPrompts[historyIndex]
					: history[historyIndex];
				if (selectedPrompt) {
					onSelectHistory(selectedPrompt);
				}
				return;
			}

			// Handle Escape to close history dropdown
			if (e.key === "Escape" && isHistoryOpen) {
				e.preventDefault();
				closeHistory();
				return;
			}

			// Handle Up arrow for history navigation
			if (e.key === "ArrowUp" && hasItems) {
				const cursorPosition = textareaRef.current?.selectionStart ?? 0;

				// Only trigger history if cursor is at the start (position 0)
				if (cursorPosition === 0) {
					e.preventDefault();

					if (!isHistoryOpen) {
						// Open history dropdown and select first item
						setIsHistoryOpen(true);
						if (pinnedLength > 0) {
							// Start with first pinned item
							setHistoryIndex(0);
							setIsPinnedSelection(true);
						} else {
							// Start with first recent item
							setHistoryIndex(0);
							setIsPinnedSelection(false);
						}
					} else {
						// Navigate toward older items
						if (isPinnedSelection) {
							// Currently in pinned section
							if (historyIndex < pinnedLength - 1) {
								// Move to next pinned item
								setHistoryIndex(historyIndex + 1);
							} else if (visibleHistoryLength > 0) {
								// Move to first recent item
								setHistoryIndex(0);
								setIsPinnedSelection(false);
							}
						} else {
							// Currently in recent section
							if (historyIndex < visibleHistoryLength - 1) {
								// Move to next recent item
								setHistoryIndex(historyIndex + 1);
							}
						}
					}
					return;
				}
			}

			// Handle Down arrow for history navigation
			if (e.key === "ArrowDown" && isHistoryOpen && hasItems) {
				e.preventDefault();

				if (isPinnedSelection) {
					// Currently in pinned section
					if (historyIndex <= 0) {
						// At first pinned item, close dropdown
						closeHistory();
					} else {
						// Move to previous pinned item
						setHistoryIndex(historyIndex - 1);
					}
				} else {
					// Currently in recent section
					if (historyIndex <= 0) {
						// At first recent item
						if (pinnedLength > 0) {
							// Move to last pinned item
							setHistoryIndex(pinnedLength - 1);
							setIsPinnedSelection(true);
						} else {
							// No pinned items, close dropdown
							closeHistory();
						}
					} else {
						// Move to previous recent item
						setHistoryIndex(historyIndex - 1);
					}
				}
				return;
			}
		},
		[
			history,
			pinnedPrompts,
			historyIndex,
			isPinnedSelection,
			isHistoryOpen,
			onSelectHistory,
			closeHistory,
			textareaRef,
		],
	);

	return {
		history,
		pinnedPrompts,
		historyIndex,
		isPinnedSelection,
		isHistoryOpen,
		setHistoryIndex: setHistoryIndexWithPinned,
		onSelectHistory,
		addToHistory,
		pinPrompt,
		unpinPrompt,
		isPinned,
		closeHistory,
		handleKeyDown,
		getValue,
	};
}
