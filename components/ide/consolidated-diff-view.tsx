import {
	AlertTriangle,
	Check,
	ChevronDown,
	ChevronRight,
	Columns2,
	Loader2,
	Rows2,
	Save,
	X,
} from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { lazy, Suspense } from "react";
import { useSWRConfig } from "swr";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

// Lazy-load Monaco DiffEditor (~2MB)
const DiffEditor = lazy(() =>
	import("@monaco-editor/react").then((mod) => ({ default: mod.DiffEditor })),
);

const EditorLoader = () => (
	<div className="flex items-center justify-center py-8 text-muted-foreground">
		<Loader2 className="h-5 w-5 animate-spin mr-2" />
		Loading diff...
	</div>
);

import { api } from "@/lib/api-client";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import { useFileEdit } from "@/lib/hooks/use-file-edit";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import {
	useSessionFileContent,
	useSessionFileDiff,
	useSessionFiles,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";
import {
	countDiffLinesFast,
	DIFF_HARD_LIMIT,
	DIFF_WARNING_THRESHOLD,
	getLanguageFromPath,
	reconstructOriginalFromPatch,
} from "@/lib/utils/diff-utils";

type DiffStyle = "split" | "unified";

/**
 * Generate a simple hash from a string for comparison purposes
 */
async function hashString(str: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(str);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface FileDiffSectionProps {
	filePath: string;
	sessionId: string;
	isExpanded: boolean;
	currentPatchHash: string | null;
	diffStyle: DiffStyle;
	onToggleExpand: () => void;
	onToggleReview: (patchHash: string) => void;
	onEdit: () => void;
}

/**
 * Individual file diff section with collapsible PatchDiff
 */
function FileDiffSection({
	filePath,
	sessionId,
	isExpanded,
	currentPatchHash,
	diffStyle,
	onToggleExpand,
	onToggleReview,
	onEdit,
}: FileDiffSectionProps) {
	const { resolvedTheme } = useTheme();
	const { mutate } = useSWRConfig();

	const {
		diff,
		isLoading: isDiffLoading,
		error: diffError,
	} = useSessionFileDiff(sessionId, filePath);

	// Load current file content for Monaco DiffEditor
	// For deleted files, we don't load current content (it doesn't exist)
	const { content: currentContent, isLoading: isContentLoading } =
		useSessionFileContent(
			sessionId,
			isExpanded && diff?.status !== "deleted" ? filePath : null,
		);

	// For deleted files, load the original content from base commit
	const {
		content: baseContent,
		isLoading: isBaseContentLoading,
		error: baseContentError,
	} = useSessionFileContent(
		sessionId,
		isExpanded && diff?.status === "deleted" ? filePath : null,
		{ fromBase: true },
	);

	// Cache the original content - only recalculate when file path or patch changes
	const [cachedOriginal, setCachedOriginal] = React.useState<{
		filePath: string;
		patch: string;
		content: string;
	} | null>(null);

	// Track the previous diff patch to detect when diff data refreshes
	const prevPatchRef = React.useRef<string | undefined>(undefined);

	// Clear cache when we detect the patch is changing (likely due to save)
	// This ensures we recalculate with fresh, synchronized data
	React.useEffect(() => {
		const currentPatch = diff?.patch;
		if (
			prevPatchRef.current !== undefined &&
			prevPatchRef.current !== currentPatch
		) {
			// Patch changed - clear cache to force recalculation with new data
			setCachedOriginal(null);
		}
		prevPatchRef.current = currentPatch;
	}, [diff?.patch]);

	// Reconstruct original content from current content and patch
	React.useEffect(() => {
		if (!diff?.patch || !isExpanded) return;

		// Only use cached version if BOTH file path AND patch match
		if (
			cachedOriginal?.filePath === filePath &&
			cachedOriginal?.patch === diff.patch
		) {
			return;
		}

		let original = "";

		if (diff.status === "deleted") {
			// For deleted files, try to use the base content from git
			if (baseContent) {
				original = baseContent;
			} else if (baseContentError || (!isBaseContentLoading && !baseContent)) {
				// Fallback: reconstruct from patch if base content fails or isn't available
				// Extract all deletion lines from the patch
				const lines = diff.patch.split("\n");
				const contentLines: string[] = [];
				for (const line of lines) {
					// Skip diff headers (---, +++, @@)
					if (
						line.startsWith("---") ||
						line.startsWith("+++") ||
						line.startsWith("@@")
					) {
						continue;
					}
					// Extract deletion lines (but not added lines)
					if (line.startsWith("-")) {
						contentLines.push(line.substring(1)); // Remove the '-' prefix
					}
				}
				original = contentLines.join("\n");
			}
		} else if (currentContent !== undefined) {
			// For non-deleted files, reconstruct from current content and patch
			// Wait until currentContent is loaded to avoid reconstructing with stale data
			if (isContentLoading) return;
			original = reconstructOriginalFromPatch(currentContent, diff.patch);
		} else {
			// Content not available yet
			return;
		}

		if (original || original === "") {
			setCachedOriginal({
				filePath,
				patch: diff.patch,
				content: original,
			});
		}
	}, [
		currentContent,
		baseContent,
		baseContentError,
		isBaseContentLoading,
		diff,
		filePath,
		isExpanded,
		isContentLoading,
		cachedOriginal,
	]);

	const originalContent = cachedOriginal?.content || "";

	// Detect language for syntax highlighting
	const language = React.useMemo(
		() => getLanguageFromPath(filePath),
		[filePath],
	);

	// Integrate useFileEdit hook for editing functionality (always enabled)
	const fileEdit = useFileEdit(
		sessionId,
		filePath,
		currentContent,
		isContentLoading,
	);

	// Use ref to access latest fileEdit in onMount callback
	const fileEditRef = React.useRef(fileEdit);

	React.useEffect(() => {
		fileEditRef.current = fileEdit;
	}, [fileEdit]);

	// Compute hash of current patch
	const [patchHash, setPatchHash] = React.useState<string | null>(null);
	React.useEffect(() => {
		if (diff?.patch) {
			hashString(diff.patch).then(setPatchHash);
		} else {
			setPatchHash(null);
		}
	}, [diff?.patch]);

	// File is reviewed if the stored hash matches the current patch hash
	const isReviewed = patchHash !== null && patchHash === currentPatchHash;

	// Handle review - navigation is handled by toggleReviewed in parent
	const handleReviewClick = () => {
		if (patchHash) {
			onToggleReview(patchHash);
		}
	};

	// Check if diff is too large to render (using fast counting)
	const diffLineCount = React.useMemo(() => {
		if (!diff?.patch) return 0;
		return countDiffLinesFast(diff.patch);
	}, [diff?.patch]);

	// Track whether user wants to force load a large diff
	const [forceLoadLargeDiff, setForceLoadLargeDiff] = React.useState(false);

	// Track conflict dialog state
	const [showConflictDialog, setShowConflictDialog] = React.useState(false);

	// Track previous file path to detect changes
	const prevFilePathRef = React.useRef(filePath);

	// Reset force load when file changes
	React.useEffect(() => {
		if (prevFilePathRef.current !== filePath) {
			setForceLoadLargeDiff(false);
			prevFilePathRef.current = filePath;
		}
	});

	// Auto-unmark as reviewed when user makes edits
	React.useEffect(() => {
		if (fileEdit.state.isDirty && isReviewed && patchHash) {
			onToggleReview(patchHash);
		}
	}, [fileEdit.state.isDirty, isReviewed, patchHash, onToggleReview]);

	// Keyboard shortcut: Cmd+S / Ctrl+S to save
	React.useEffect(() => {
		if (!isExpanded) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				if (fileEdit.state.isDirty && !fileEdit.state.isSaving) {
					fileEdit.save().then((success) => {
						if (success) {
							// Refresh diff data after save
							setTimeout(() => {
								mutate(`session-diff-${sessionId}-files`);
								mutate(`session-diff-${sessionId}-${filePath}`);
							}, 100);
						}
					});
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isExpanded, fileEdit, sessionId, filePath, mutate]);

	const isOverHardLimit = diffLineCount > DIFF_HARD_LIMIT;
	const isOverWarningThreshold =
		diffLineCount > DIFF_WARNING_THRESHOLD && diffLineCount <= DIFF_HARD_LIMIT;
	const shouldShowFallback =
		(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

	return (
		<div
			className={cn(
				"border-b border-border",
				isExpanded && "flex-1 flex flex-col overflow-hidden",
			)}
		>
			{/* File header - always visible */}
			<div
				className={cn(
					"sticky top-0 z-10 flex items-center justify-between px-4 py-2 bg-muted/20 backdrop-blur-sm",
					isReviewed && "opacity-60",
				)}
			>
				{/* biome-ignore lint/a11y/useSemanticElements: Can't use button - contains other buttons */}
				<div
					role="button"
					tabIndex={0}
					className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer hover:opacity-80 transition-opacity"
					onClick={onToggleExpand}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onToggleExpand();
						}
					}}
				>
					{isExpanded ? (
						<ChevronDown className="h-4 w-4 shrink-0" />
					) : (
						<ChevronRight className="h-4 w-4 shrink-0" />
					)}
					<span className="font-mono text-sm truncate">{filePath}</span>
					{diff && !diff.binary && (
						<span className="flex items-center gap-1 text-xs shrink-0">
							<span className="text-green-500">+{diff.additions}</span>
							<span className="text-red-500">-{diff.deletions}</span>
						</span>
					)}
					{diff?.status && (
						<span
							className={cn(
								"text-xs font-medium px-1.5 py-0.5 rounded shrink-0",
								diff.status === "added" &&
									"bg-green-500/20 text-green-500 border border-green-500/30",
								diff.status === "modified" &&
									"bg-yellow-500/20 text-yellow-500 border border-yellow-500/30",
								diff.status === "deleted" &&
									"bg-red-500/20 text-red-500 border border-red-500/30",
								diff.status === "renamed" &&
									"bg-purple-500/20 text-purple-500 border border-purple-500/30",
							)}
						>
							{diff.status === "added"
								? "Added"
								: diff.status === "modified"
									? "Modified"
									: diff.status === "deleted"
										? "Deleted"
										: "Renamed"}
						</span>
					)}
					{isReviewed && (
						<span className="flex items-center gap-1 text-xs text-green-500 shrink-0">
							<Check className="h-3 w-3" />
							Reviewed
						</span>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					{/* Status indicators */}
					{fileEdit.state.hasConflict && (
						<button
							type="button"
							className="flex items-center gap-1 text-xs text-yellow-500 shrink-0 hover:underline"
							onClick={(e) => {
								e.stopPropagation();
								setShowConflictDialog(true);
							}}
							title="Click to resolve conflict"
						>
							<AlertTriangle className="h-3 w-3" />
							Conflict
						</button>
					)}

					{/* Save/Discard buttons - only show when dirty and for non-deleted files */}
					{diff?.status !== "deleted" && fileEdit.state.isDirty && (
						<>
							<Button
								variant="default"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={async (e) => {
									e.stopPropagation();
									const success = await fileEdit.save();
									if (success) {
										// Refresh diff data after save
										setTimeout(() => {
											mutate(`session-diff-${sessionId}-files`);
											mutate(`session-diff-${sessionId}-${filePath}`);
										}, 100);
									}
								}}
								disabled={fileEdit.state.isSaving}
								title="Save changes (Cmd/Ctrl+S)"
							>
								{fileEdit.state.isSaving ? (
									<Loader2 className="h-3 w-3 mr-1 animate-spin" />
								) : (
									<Save className="h-3 w-3 mr-1" />
								)}
								Save
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={(e) => {
									e.stopPropagation();
									fileEdit.discard();
								}}
								title="Discard changes"
							>
								<X className="h-3 w-3 mr-1" />
								Discard
							</Button>
						</>
					)}
					<Button
						variant={isReviewed ? "secondary" : "ghost"}
						size="sm"
						className="h-6 px-2 text-xs"
						onClick={(e) => {
							e.stopPropagation();
							handleReviewClick();
						}}
					>
						{isReviewed ? (
							<>
								<Check className="h-3 w-3 mr-1" />
								Reviewed
							</>
						) : (
							"Mark as Reviewed"
						)}
					</Button>
				</div>
			</div>

			{/* Expandable diff content */}
			{isExpanded && (
				<div className="flex-1 bg-background overflow-hidden">
					{isDiffLoading || isContentLoading || isBaseContentLoading ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin mr-2" />
							Loading diff...
						</div>
					) : diffError ? (
						<div className="flex items-center justify-center py-8 text-destructive">
							Failed to load: {diffError.message}
						</div>
					) : !diff || !diff.patch ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							No diff available
						</div>
					) : diff.binary ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							Binary file - cannot display diff
						</div>
					) : shouldShowFallback ? (
						<div className="flex items-center justify-center py-8 px-4">
							<div className="max-w-md text-center space-y-3">
								<div className="text-yellow-500 text-sm font-medium">
									⚠️ Large Diff ({diffLineCount.toLocaleString()} lines)
								</div>
								<p className="text-xs text-muted-foreground">
									This diff is too large to display in the consolidated view.
								</p>
								<div className="flex flex-col gap-2 pt-2">
									{isOverWarningThreshold && !isOverHardLimit && (
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												React.startTransition(() => {
													setForceLoadLargeDiff(true);
												});
											}}
										>
											Load Anyway (May Be Slow)
										</Button>
									)}
									<Button size="sm" variant="outline" onClick={onEdit}>
										View in Tab
									</Button>
								</div>
							</div>
						</div>
					) : !originalContent && (isContentLoading || isBaseContentLoading) ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							Loading file content...
						</div>
					) : (
						<Suspense fallback={<EditorLoader />}>
							<DiffEditor
								key={filePath}
								height="100%"
								language={language}
								original={originalContent}
								modified={
									diff.status === "deleted" ? "" : fileEdit.state.content || ""
								}
								theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
								options={{
									readOnly: diff.status === "deleted",
									renderSideBySide: diffStyle === "split",
									minimap: { enabled: false },
									hideUnchangedRegions: {
										enabled: true,
										minimumLineCount: 3,
										contextLineCount: 3,
									},
									diffWordWrap: "on",
									scrollBeyondLastLine: false,
									automaticLayout: true,
									fontSize: 13,
								}}
								onMount={(editor) => {
									// Get the modified (right-side) editor
									const modifiedEditor = editor.getModifiedEditor();

									// Attach change listener
									const disposable = modifiedEditor.onDidChangeModelContent(
										() => {
											// Use ref to get latest fileEdit
											const currentFileEdit = fileEditRef.current;

											// Always handle edits (unless it's a deleted file)
											if (diff.status !== "deleted") {
												const value = modifiedEditor.getValue();
												currentFileEdit.handleEdit(value);
											}
										},
									);

									// Clean up on unmount
									return () => disposable.dispose();
								}}
							/>
						</Suspense>
					)}
				</div>
			)}

			{/* Conflict Resolution Dialog */}
			<Dialog open={showConflictDialog} onOpenChange={setShowConflictDialog}>
				<DialogContent className="max-w-4xl h-[80vh]">
					<DialogHeader>
						<DialogTitle>File Conflict Detected</DialogTitle>
						<DialogDescription>
							The file has been modified since you started editing. Choose how
							to proceed.
						</DialogDescription>
					</DialogHeader>
					<div className="flex-1 overflow-hidden" style={{ height: "500px" }}>
						{fileEdit.state.conflictContent && (
							<Suspense fallback={<EditorLoader />}>
								<DiffEditor
									key={`conflict-${filePath}`}
									height="100%"
									language={language}
									original={fileEdit.state.conflictContent}
									modified={fileEdit.state.content}
									theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
									options={{
										readOnly: true,
										renderSideBySide: true,
										minimap: { enabled: false },
										scrollBeyondLastLine: false,
										automaticLayout: true,
									}}
								/>
							</Suspense>
						)}
						<div className="mt-4 space-y-2 text-sm">
							<p>
								<strong>Left (Server):</strong> Current file content on disk
							</p>
							<p>
								<strong>Right (Your Changes):</strong> Your local edits
							</p>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setShowConflictDialog(false);
							}}
						>
							Keep Editing
						</Button>
						<Button
							variant="outline"
							onClick={() => {
								fileEdit.acceptServerContent();
								setShowConflictDialog(false);
							}}
						>
							Use Disk Version
						</Button>
						<Button
							variant="default"
							onClick={async () => {
								const success = await fileEdit.forceSave();
								if (success) {
									mutate(`session-diff-${sessionId}-files`);
									mutate(`session-diff-${sessionId}-${filePath}`);
									setShowConflictDialog(false);
								}
							}}
						>
							Force Save My Changes
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * Consolidated diff view showing all changed files in a GitHub-style stacked layout.
 * Each file is collapsible and can be marked as reviewed (persisted in localStorage).
 */
export function ConsolidatedDiffView() {
	const { selectedSessionId, handleFileSelect, setActiveView } =
		useSessionViewContext();

	// Track diff style preference (split/unified)
	const [diffStyle, setDiffStyle] = usePersistedState<DiffStyle>(
		STORAGE_KEYS.CONSOLIDATED_DIFF_STYLE,
		"split",
		"local",
	);

	// Get all changed files from session
	const { diffEntries, isLoading: isLoadingFiles } = useSessionFiles(
		selectedSessionId,
		false,
	);

	// Track collapsed files (not persisted - always start with all collapsed)
	// Initialize with all files collapsed
	const [collapsedFiles, setCollapsedFiles] = React.useState<string[]>(() =>
		diffEntries.map((f) => f.path),
	);

	// Reset collapsed state only when the file paths actually change (e.g., switching sessions)
	// Not when diffEntries updates due to cache invalidation after save
	const filePaths = React.useMemo(
		() => diffEntries.map((f) => f.path).join(","),
		[diffEntries],
	);
	const prevFilePathsRef = React.useRef(filePaths);

	React.useEffect(() => {
		if (prevFilePathsRef.current !== filePaths) {
			setCollapsedFiles(diffEntries.map((f) => f.path));
			prevFilePathsRef.current = filePaths;
		}
	}, [filePaths, diffEntries]);

	// Track reviewed state per session+file with patch hash (in localStorage)
	// Format: { sessionId: { filePath: patchHash } }
	const [reviewedFiles, setReviewedFiles] = usePersistedState<
		Record<string, Record<string, string>>
	>(STORAGE_KEYS.CONSOLIDATED_DIFF_REVIEWED, {}, "local");

	// Get reviewed files for current session as a Map of filePath -> patchHash
	const sessionReviewedFiles = React.useMemo(
		() => new Map(Object.entries(reviewedFiles[selectedSessionId || ""] || {})),
		[reviewedFiles, selectedSessionId],
	);

	const collapsedFilesSet = React.useMemo(
		() => new Set(collapsedFiles),
		[collapsedFiles],
	);

	const toggleExpanded = React.useCallback(
		(filePath: string) => {
			setCollapsedFiles((prev) => {
				const isCurrentlyExpanded = !prev.includes(filePath);

				if (isCurrentlyExpanded) {
					// File is expanded, collapse it (close accordion)
					return diffEntries.map((f) => f.path);
				}

				// File is collapsed, expand it and collapse all others
				const allOtherFiles = diffEntries
					.map((f) => f.path)
					.filter((p) => p !== filePath);
				return allOtherFiles;
			});
		},
		[diffEntries],
	);

	const toggleReviewed = React.useCallback(
		(filePath: string, patchHash: string) => {
			if (!selectedSessionId) return;

			// Get current reviewed files for this session
			const sessionFiles = { ...(reviewedFiles[selectedSessionId] || {}) };
			const wasReviewed = sessionFiles[filePath] === patchHash;

			// Check if this file is currently expanded
			const isCurrentlyExpanded = !collapsedFiles.includes(filePath);

			// Update reviewed state
			if (wasReviewed) {
				delete sessionFiles[filePath];
			} else {
				sessionFiles[filePath] = patchHash;
			}

			setReviewedFiles((prev) => ({
				...prev,
				[selectedSessionId]: sessionFiles,
			}));

			// Only auto-advance if we just marked as reviewed AND the file is currently expanded
			if (!wasReviewed && isCurrentlyExpanded) {
				const currentIndex = diffEntries.findIndex((f) => f.path === filePath);
				const nextUnreviewed = diffEntries
					.slice(currentIndex + 1)
					.find((f) => !sessionFiles[f.path]);

				if (nextUnreviewed) {
					// Collapse all others and expand the next unreviewed file
					const allOtherFiles = diffEntries
						.map((f) => f.path)
						.filter((p) => p !== nextUnreviewed.path);
					setCollapsedFiles(allOtherFiles);
				} else {
					// No more unreviewed files, collapse everything
					setCollapsedFiles(diffEntries.map((f) => f.path));
				}
			}
		},
		[
			selectedSessionId,
			reviewedFiles,
			setReviewedFiles,
			diffEntries,
			collapsedFiles,
		],
	);

	const markAllReviewed = React.useCallback(async () => {
		if (!selectedSessionId) return;

		// Fetch all diffs to get patch hashes
		const sessionFiles: Record<string, string> = {};

		for (const file of diffEntries) {
			try {
				// Fetch the diff for this file using the API client
				const diffData = await api.getSessionDiff(selectedSessionId, {
					path: file.path,
				});
				if ("patch" in diffData && diffData.patch) {
					const hash = await hashString(diffData.patch);
					sessionFiles[file.path] = hash;
				}
			} catch (error) {
				console.error(`Failed to fetch diff for ${file.path}:`, error);
			}
		}

		setReviewedFiles((prev) => ({
			...prev,
			[selectedSessionId]: sessionFiles,
		}));
	}, [selectedSessionId, diffEntries, setReviewedFiles]);

	const handleEditFile = React.useCallback(
		(filePath: string) => {
			handleFileSelect(filePath);
			setActiveView(`file:${filePath}`);
		},
		[handleFileSelect, setActiveView],
	);

	if (!selectedSessionId) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				No session selected
			</div>
		);
	}

	if (isLoadingFiles) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<Loader2 className="h-5 w-5 animate-spin mr-2" />
				Loading files...
			</div>
		);
	}

	if (diffEntries.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				No changed files to display
			</div>
		);
	}

	// Note: We can't easily check if all are reviewed with current hashes without loading all diffs
	// So we just check if all file paths have a stored hash (may be outdated)
	const allReviewed = diffEntries.every((f) =>
		sessionReviewedFiles.has(f.path),
	);

	return (
		<div className="flex-1 flex flex-col overflow-hidden h-full">
			{/* Toolbar */}
			<div className="h-10 flex items-center justify-between px-4 border-b border-border bg-muted/20 shrink-0">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">
						{diffEntries.length} changed file
						{diffEntries.length === 1 ? "" : "s"}
					</span>
					{sessionReviewedFiles.size > 0 && (
						<span className="text-xs text-muted-foreground">
							({sessionReviewedFiles.size} reviewed)
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					{/* Diff style toggle */}
					<div className="flex items-center rounded-md border border-border bg-background">
						<Button
							variant="ghost"
							size="sm"
							className={cn(
								"h-6 px-1.5 rounded-r-none",
								diffStyle === "split" && "bg-muted",
							)}
							onClick={() => setDiffStyle("split")}
							title="Side by side"
						>
							<Columns2 className="h-3.5 w-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className={cn(
								"h-6 px-1.5 rounded-l-none border-l border-border",
								diffStyle === "unified" && "bg-muted",
							)}
							onClick={() => setDiffStyle("unified")}
							title="Unified"
						>
							<Rows2 className="h-3.5 w-3.5" />
						</Button>
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="h-6 text-xs"
						onClick={markAllReviewed}
						disabled={allReviewed}
					>
						<Check className="h-3 w-3 mr-1" />
						Mark All Reviewed
					</Button>
				</div>
			</div>

			{/* File diffs list */}
			<div className="flex-1 flex flex-col overflow-y-auto">
				{diffEntries.map((file) => (
					<FileDiffSection
						key={file.path}
						filePath={file.path}
						sessionId={selectedSessionId}
						isExpanded={!collapsedFilesSet.has(file.path)}
						currentPatchHash={sessionReviewedFiles.get(file.path) || null}
						diffStyle={diffStyle}
						onToggleExpand={() => toggleExpanded(file.path)}
						onToggleReview={(hash) => toggleReviewed(file.path, hash)}
						onEdit={() => handleEditFile(file.path)}
					/>
				))}
			</div>
		</div>
	);
}
