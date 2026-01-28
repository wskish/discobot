import { useCallback, useEffect, useState } from "react";
import { api, FileConflictError } from "../api-client";

const STORAGE_PREFIX = "octobot:file-edit:";

interface StoredEditState {
	originalContent: string;
	editedContent: string;
	timestamp: number;
}

function getStorageKey(sessionId: string, path: string): string {
	return `${STORAGE_PREFIX}${sessionId}:${path}`;
}

function loadEditState(
	sessionId: string,
	path: string,
): StoredEditState | null {
	if (typeof window === "undefined") return null;
	try {
		const key = getStorageKey(sessionId, path);
		const stored = sessionStorage.getItem(key);
		if (stored) {
			return JSON.parse(stored);
		}
	} catch {
		// Ignore parse errors
	}
	return null;
}

function saveEditState(
	sessionId: string,
	path: string,
	state: StoredEditState,
): void {
	if (typeof window === "undefined") return;
	try {
		const key = getStorageKey(sessionId, path);
		sessionStorage.setItem(key, JSON.stringify(state));
	} catch {
		// Ignore storage errors (quota exceeded, etc.)
	}
}

function clearEditState(sessionId: string, path: string): void {
	if (typeof window === "undefined") return;
	try {
		const key = getStorageKey(sessionId, path);
		sessionStorage.removeItem(key);
	} catch {
		// Ignore errors
	}
}

export interface FileEditState {
	/** Current content being edited */
	content: string;
	/** Original content from server (for dirty check and optimistic locking) */
	originalContent: string;
	/** Whether content has been modified */
	isDirty: boolean;
	/** Whether we're in the process of saving */
	isSaving: boolean;
	/** Error message if save failed */
	saveError: string | null;
	/** Whether a conflict was detected */
	hasConflict: boolean;
	/** Server content when conflict detected */
	conflictContent: string | null;
}

export interface UseFileEditResult {
	state: FileEditState;
	/** Called when user makes an edit - handles pre-edit check */
	handleEdit: (newContent: string) => Promise<void>;
	/** Save current content to server */
	save: () => Promise<boolean>;
	/** Reload content from server (discards local changes) */
	reload: () => Promise<void>;
	/** Accept server content after conflict */
	acceptServerContent: () => void;
	/** Force save (ignore conflict) */
	forceSave: () => Promise<boolean>;
	/** Discard local changes */
	discard: () => void;
}

export function useFileEdit(
	sessionId: string | null,
	path: string | null,
	serverContent: string | undefined,
	_isServerLoading: boolean,
): UseFileEditResult {
	const [state, setState] = useState<FileEditState>({
		content: "",
		originalContent: "",
		isDirty: false,
		isSaving: false,
		saveError: null,
		hasConflict: false,
		conflictContent: null,
	});

	// Track if this is the first edit (need to check server before editing)
	const [hasStartedEditing, setHasStartedEditing] = useState(false);
	const [isCheckingServer, setIsCheckingServer] = useState(false);

	// Initialize from server content or sessionStorage
	useEffect(() => {
		if (!sessionId || !path || serverContent === undefined) return;

		// Check if we have stored edit state
		const storedState = loadEditState(sessionId, path);

		if (storedState && storedState.originalContent === serverContent) {
			// Restore edit state - server content matches our original
			setState({
				content: storedState.editedContent,
				originalContent: storedState.originalContent,
				isDirty: storedState.editedContent !== storedState.originalContent,
				isSaving: false,
				saveError: null,
				hasConflict: false,
				conflictContent: null,
			});
			setHasStartedEditing(
				storedState.editedContent !== storedState.originalContent,
			);
		} else if (storedState && storedState.originalContent !== serverContent) {
			// Server content changed since we started editing - conflict!
			setState({
				content: storedState.editedContent,
				originalContent: storedState.originalContent,
				isDirty: true,
				isSaving: false,
				saveError: null,
				hasConflict: true,
				conflictContent: serverContent,
			});
			setHasStartedEditing(true);
		} else {
			// No stored state - use server content
			setState({
				content: serverContent,
				originalContent: serverContent,
				isDirty: false,
				isSaving: false,
				saveError: null,
				hasConflict: false,
				conflictContent: null,
			});
			setHasStartedEditing(false);
		}
	}, [sessionId, path, serverContent]);

	// Handle edit with pre-edit server check
	const handleEdit = useCallback(
		async (newContent: string) => {
			if (!sessionId || !path) return;

			// If this is the first edit, check server for changes first
			if (!hasStartedEditing && !isCheckingServer) {
				setIsCheckingServer(true);
				try {
					const freshContent = await api.readSessionFile(sessionId, path);

					if (freshContent.content !== state.originalContent) {
						// Server content changed - notify user and reload
						setState((prev) => ({
							...prev,
							content: freshContent.content,
							originalContent: freshContent.content,
							hasConflict: false,
							conflictContent: null,
						}));
						// Clear any stored state since we're resetting
						clearEditState(sessionId, path);
						setIsCheckingServer(false);
						// Don't apply the edit - user needs to start fresh
						return;
					}
				} catch {
					// If we can't check, proceed anyway
				}
				setIsCheckingServer(false);
				setHasStartedEditing(true);
			}

			// Apply the edit
			const isDirty = newContent !== state.originalContent;
			setState((prev) => ({
				...prev,
				content: newContent,
				isDirty,
				saveError: null,
			}));

			// Save to sessionStorage
			if (isDirty) {
				saveEditState(sessionId, path, {
					originalContent: state.originalContent,
					editedContent: newContent,
					timestamp: Date.now(),
				});
			} else {
				// Content matches original - clear storage
				clearEditState(sessionId, path);
			}
		},
		[
			sessionId,
			path,
			hasStartedEditing,
			isCheckingServer,
			state.originalContent,
		],
	);

	// Save to server
	const save = useCallback(async (): Promise<boolean> => {
		if (!sessionId || !path || !state.isDirty) return true;

		setState((prev) => ({ ...prev, isSaving: true, saveError: null }));

		try {
			await api.writeSessionFile(sessionId, {
				path,
				content: state.content,
				originalContent: state.originalContent,
			});

			// Success - update original content and clear storage
			setState((prev) => ({
				...prev,
				originalContent: prev.content,
				isDirty: false,
				isSaving: false,
				saveError: null,
				hasConflict: false,
				conflictContent: null,
			}));
			clearEditState(sessionId, path);
			setHasStartedEditing(false);
			return true;
		} catch (error) {
			if (error instanceof FileConflictError) {
				setState((prev) => ({
					...prev,
					isSaving: false,
					saveError: "File has been modified by another process",
					hasConflict: true,
					conflictContent: error.currentContent,
				}));
			} else {
				setState((prev) => ({
					...prev,
					isSaving: false,
					saveError: error instanceof Error ? error.message : "Save failed",
				}));
			}
			return false;
		}
	}, [sessionId, path, state.content, state.originalContent, state.isDirty]);

	// Force save (ignore conflict)
	const forceSave = useCallback(async (): Promise<boolean> => {
		if (!sessionId || !path) return false;

		setState((prev) => ({ ...prev, isSaving: true, saveError: null }));

		try {
			// Don't send originalContent to bypass optimistic locking
			await api.writeSessionFile(sessionId, {
				path,
				content: state.content,
			});

			setState((prev) => ({
				...prev,
				originalContent: prev.content,
				isDirty: false,
				isSaving: false,
				saveError: null,
				hasConflict: false,
				conflictContent: null,
			}));
			clearEditState(sessionId, path);
			setHasStartedEditing(false);
			return true;
		} catch (error) {
			setState((prev) => ({
				...prev,
				isSaving: false,
				saveError: error instanceof Error ? error.message : "Save failed",
			}));
			return false;
		}
	}, [sessionId, path, state.content]);

	// Reload from server
	const reload = useCallback(async () => {
		if (!sessionId || !path) return;

		try {
			const freshContent = await api.readSessionFile(sessionId, path);
			setState({
				content: freshContent.content,
				originalContent: freshContent.content,
				isDirty: false,
				isSaving: false,
				saveError: null,
				hasConflict: false,
				conflictContent: null,
			});
			clearEditState(sessionId, path);
			setHasStartedEditing(false);
		} catch (error) {
			setState((prev) => ({
				...prev,
				saveError: error instanceof Error ? error.message : "Reload failed",
			}));
		}
	}, [sessionId, path]);

	// Accept server content after conflict
	const acceptServerContent = useCallback(() => {
		if (!state.conflictContent || !sessionId || !path) return;

		setState({
			content: state.conflictContent,
			originalContent: state.conflictContent,
			isDirty: false,
			isSaving: false,
			saveError: null,
			hasConflict: false,
			conflictContent: null,
		});
		clearEditState(sessionId, path);
		setHasStartedEditing(false);
	}, [sessionId, path, state.conflictContent]);

	// Discard local changes
	const discard = useCallback(() => {
		if (!sessionId || !path) return;

		setState((prev) => ({
			...prev,
			content: prev.originalContent,
			isDirty: false,
			saveError: null,
			hasConflict: false,
			conflictContent: null,
		}));
		clearEditState(sessionId, path);
		setHasStartedEditing(false);
	}, [sessionId, path]);

	return {
		state: {
			...state,
			// Show loading state while checking server
			isSaving: state.isSaving || isCheckingServer,
		},
		handleEdit,
		save,
		reload,
		acceptServerContent,
		forceSave,
		discard,
	};
}
