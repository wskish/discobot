import * as Diff from "diff";
import {
	AlertTriangle,
	Download,
	FileText,
	Loader2,
	Pencil,
	RotateCcw,
	Save,
} from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { lazy, Suspense } from "react";
import { useSWRConfig } from "swr";

// Lazy-load heavy Monaco editor components (~2MB)
const Editor = lazy(() =>
	import("@monaco-editor/react").then((mod) => ({ default: mod.Editor })),
);

const DiffEditor = lazy(() =>
	import("@monaco-editor/react").then((mod) => ({ default: mod.DiffEditor })),
);

const DiffEditorLoader = () => (
	<div className="flex-1 flex items-center justify-center text-muted-foreground">
		<Loader2 className="h-5 w-5 animate-spin mr-2" />
		Loading diff...
	</div>
);

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { FileNode } from "@/lib/api-types";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import { useFileEdit } from "@/lib/hooks/use-file-edit";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import {
	useSessionFileContent,
	useSessionFileDiff,
} from "@/lib/hooks/use-session-files";

type ViewMode = "diff" | "edit";

// Diff size thresholds (in lines)
const DIFF_WARNING_THRESHOLD = 10000; // Show warning but allow loading
const DIFF_HARD_LIMIT = 20000; // Never render, show fallback only

// Hoisted to module level to avoid recreation on every call
const LANGUAGE_MAP: Record<string, string> = {
	js: "javascript",
	jsx: "javascript",
	ts: "typescript",
	tsx: "typescript",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	swift: "swift",
	kt: "kotlin",
	scala: "scala",
	html: "html",
	htm: "html",
	css: "css",
	scss: "scss",
	less: "less",
	json: "json",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	sql: "sql",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	ps1: "powershell",
	dockerfile: "dockerfile",
	makefile: "makefile",
	toml: "toml",
	ini: "ini",
	conf: "ini",
	graphql: "graphql",
	gql: "graphql",
	vue: "vue",
	svelte: "svelte",
};

function getLanguageFromPath(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() || "";

	// Check for special filenames
	const filename = filePath.split("/").pop()?.toLowerCase() || "";
	if (filename === "dockerfile") return "dockerfile";
	if (filename === "makefile") return "makefile";
	if (filename.startsWith(".") && !ext) return "plaintext";

	return LANGUAGE_MAP[ext] || "plaintext";
}

/**
 * Reconstruct the original content from current content and a unified diff patch.
 * The patch format is: original -> modified
 * So we need to apply the patch in reverse to go from modified back to original.
 */
function reconstructOriginalFromPatch(
	currentContent: string,
	patch: string,
): string {
	try {
		// Parse the patch to get the structured patch object
		const parsedPatches = Diff.parsePatch(patch);
		if (parsedPatches.length === 0) {
			return currentContent;
		}

		// The patch goes from old -> new, so we need to reverse it
		// Apply the patch in reverse by swapping additions and deletions
		const reversedPatch = parsedPatches[0];

		// Swap old and new for reverse application
		const originalPatch = {
			...reversedPatch,
			hunks: reversedPatch.hunks.map((hunk) => ({
				...hunk,
				lines: hunk.lines.map((line) => {
					// Swap + and - to reverse the patch
					if (line.startsWith("+")) {
						return `-${line.slice(1)}`;
					}
					if (line.startsWith("-")) {
						return `+${line.slice(1)}`;
					}
					return line;
				}),
				oldStart: hunk.newStart,
				oldLines: hunk.newLines,
				newStart: hunk.oldStart,
				newLines: hunk.oldLines,
			})),
		};

		// Apply the reversed patch to get the original content
		const result = Diff.applyPatch(currentContent, originalPatch);
		return typeof result === "string" ? result : currentContent;
	} catch (error) {
		console.error("Failed to reconstruct original from patch:", error);
		return currentContent;
	}
}

/**
 * Count the total number of lines in a unified diff patch.
 * This includes context lines, additions, and deletions.
 */
function countDiffLines(patch: string): number {
	try {
		const parsedPatches = Diff.parsePatch(patch);
		if (parsedPatches.length === 0) {
			return 0;
		}

		let totalLines = 0;
		for (const parsedPatch of parsedPatches) {
			for (const hunk of parsedPatch.hunks) {
				totalLines += hunk.lines.length;
			}
		}

		return totalLines;
	} catch (error) {
		console.error("Failed to count diff lines:", error);
		return 0;
	}
}

interface LargeDiffFallbackProps {
	lineCount: number;
	filePath: string;
	patch: string;
	onViewCurrent: () => void;
	canLoadAnyway: boolean;
	onLoadAnyway?: () => void;
}

function LargeDiffFallback({
	lineCount,
	filePath,
	patch,
	onViewCurrent,
	canLoadAnyway,
	onLoadAnyway,
}: LargeDiffFallbackProps) {
	const handleDownloadPatch = () => {
		const blob = new Blob([patch], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${filePath.split("/").pop()}.patch`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex-1 flex items-center justify-center p-8">
			<div className="max-w-md text-center space-y-4">
				<div className="flex justify-center">
					<div className="rounded-full bg-yellow-500/10 p-3">
						<AlertTriangle className="h-8 w-8 text-yellow-500" />
					</div>
				</div>
				<div>
					<h3 className="text-lg font-semibold mb-2">
						Diff Too Large to Display
					</h3>
					<p className="text-sm text-muted-foreground">
						This diff contains{" "}
						<span className="font-medium text-foreground">
							{lineCount.toLocaleString()} lines
						</span>
						, which exceeds the rendering limit. Choose an option below to view
						the changes.
					</p>
				</div>
				<div className="flex flex-col gap-2 pt-2">
					{canLoadAnyway && onLoadAnyway && (
						<Button
							variant="default"
							className="w-full justify-start"
							onClick={onLoadAnyway}
						>
							<AlertTriangle className="h-4 w-4 mr-2" />
							Load Anyway (May Be Slow)
						</Button>
					)}
					<Button
						variant="outline"
						className="w-full justify-start"
						onClick={onViewCurrent}
					>
						<FileText className="h-4 w-4 mr-2" />
						View Current File
					</Button>
					<Button
						variant="outline"
						className="w-full justify-start"
						onClick={handleDownloadPatch}
					>
						<Download className="h-4 w-4 mr-2" />
						Download as .patch File
					</Button>
				</div>
				<p className="text-xs text-muted-foreground pt-2">
					Consider using an external diff tool for very large changes.
				</p>
			</div>
		</div>
	);
}

interface DiffContentProps {
	file: FileNode;
}

export function DiffContent({ file }: DiffContentProps) {
	// Persist view modes per file (diff vs edit) in sessionStorage
	const [viewModes, setViewModes] = usePersistedState<Record<string, ViewMode>>(
		STORAGE_KEYS.FILE_VIEW_MODES,
		{},
		"session",
	);

	// Get/set view mode for a specific file
	const viewMode = viewModes[file.id] ?? "diff";

	const setViewMode = React.useCallback(
		(mode: ViewMode) => {
			setViewModes((prev) => ({ ...prev, [file.id]: mode }));
		},
		[setViewModes, file.id],
	);

	const { selectedSession } = useSessionViewContext();
	const { resolvedTheme } = useTheme();

	const {
		diff,
		isLoading: isDiffLoading,
		error: diffError,
	} = useSessionFileDiff(
		selectedSession?.id ?? null,
		file.id, // file.id is the file path
	);

	// Check if the file is deleted (can't edit or view current content)
	const isDeleted = file.status === "deleted" || diff?.status === "deleted";

	// Check if we should show file content instead of diff (no diff available)
	const noDiffAvailable =
		!isDiffLoading && (!diff || diff.status === "unchanged");

	// Load current file content (for edit mode, when no diff available, and for diff viewer)
	// Don't load content for deleted files
	const shouldLoadContent =
		!isDeleted && (viewMode === "edit" || noDiffAvailable || !!diff);
	const {
		content: currentContent,
		isLoading: isContentLoading,
		error: contentError,
	} = useSessionFileContent(
		shouldLoadContent ? (selectedSession?.id ?? null) : null,
		shouldLoadContent ? file.id : null,
	);

	// Don't wait for original content - show diff immediately, expansion is optional
	const isLoading =
		isDiffLoading ||
		(noDiffAvailable && isContentLoading) ||
		(viewMode === "edit" && isContentLoading);

	// Reconstruct original content from current content and patch
	// This must be called unconditionally at the top level (React hooks rules)
	const originalContent = React.useMemo(() => {
		if (!currentContent || !diff?.patch) {
			return "";
		}
		if (file.status === "added") {
			// For new files, original is empty
			return "";
		}
		if (isDeleted) {
			// For deleted files, only original exists (no current content)
			return currentContent;
		}
		return reconstructOriginalFromPatch(currentContent, diff.patch);
	}, [currentContent, diff?.patch, file.status, isDeleted]);

	// Count diff lines to determine if it's too large to render
	const diffLineCount = React.useMemo(() => {
		if (!diff?.patch) return 0;
		return countDiffLines(diff.patch);
	}, [diff?.patch]);

	// Track whether user wants to force load a large diff
	const [forceLoadLargeDiff, setForceLoadLargeDiff] = React.useState(false);

	// Reset force load when file changes
	React.useEffect(() => {
		setForceLoadLargeDiff(false);
	}, []);

	const language = getLanguageFromPath(file.id);

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				<Loader2 className="h-5 w-5 animate-spin mr-2" />
				{isDiffLoading ? "Loading diff..." : "Loading file..."}
			</div>
		);
	}

	if (diffError && !noDiffAvailable) {
		return (
			<div className="flex-1 flex items-center justify-center text-destructive">
				Failed to load diff: {diffError.message}
			</div>
		);
	}

	// Show file content when no diff available or in edit mode
	if (noDiffAvailable || viewMode === "edit") {
		if (contentError) {
			return (
				<div className="flex-1 flex items-center justify-center text-destructive">
					Failed to load file: {contentError.message}
				</div>
			);
		}

		if (currentContent === undefined || currentContent === null) {
			return (
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					No content available
				</div>
			);
		}

		return (
			<FileContentView
				content={currentContent}
				filePath={file.id}
				isServerLoading={isContentLoading}
				onBackToDiff={!noDiffAvailable ? () => setViewMode("diff") : undefined}
			/>
		);
	}

	if (!diff || !diff.patch) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				No diff available
			</div>
		);
	}

	if (diff.binary) {
		return (
			<div className="flex-1 flex items-center justify-center text-muted-foreground">
				Binary file - cannot display diff
			</div>
		);
	}

	// Check if diff is too large to render
	const isOverHardLimit = diffLineCount > DIFF_HARD_LIMIT;
	const isOverWarningThreshold =
		diffLineCount > DIFF_WARNING_THRESHOLD && diffLineCount <= DIFF_HARD_LIMIT;
	const shouldShowFallback =
		(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

	if (shouldShowFallback) {
		return (
			<LargeDiffFallback
				lineCount={diffLineCount}
				filePath={file.id}
				patch={diff.patch}
				onViewCurrent={() => setViewMode("edit")}
				canLoadAnyway={isOverWarningThreshold && !isOverHardLimit}
				onLoadAnyway={
					isOverWarningThreshold ? () => setForceLoadLargeDiff(true) : undefined
				}
			/>
		);
	}

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Diff header toolbar */}
			<div className="h-8 flex items-center justify-between px-2 border-b border-border bg-muted/20 shrink-0">
				<div className="flex items-center gap-3">
					{/* Show large diff warning if force loaded */}
					{forceLoadLargeDiff && (
						<span className="text-xs text-yellow-500 font-medium flex items-center gap-1">
							<AlertTriangle className="h-3 w-3" />
							Large diff ({diffLineCount.toLocaleString()} lines)
						</span>
					)}
					{/* Show status badge */}
					{file.status === "added" && (
						<span className="text-xs text-green-500 font-medium">New File</span>
					)}
					{isDeleted && (
						<span className="text-xs text-red-500 font-medium">
							File Deleted
						</span>
					)}
					{file.status === "renamed" && (
						<span className="text-xs text-purple-500 font-medium">Renamed</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					{/* Show Edit button for non-deleted files */}
					{!isDeleted && (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-xs"
							onClick={() => setViewMode("edit")}
							title="Edit file"
						>
							<Pencil className="h-3 w-3 mr-1" />
							Edit
						</Button>
					)}
				</div>
			</div>
			{/* Monaco DiffEditor */}
			<div className="flex-1 overflow-hidden">
				<Suspense fallback={<DiffEditorLoader />}>
					<DiffEditor
						key={`diff-${file.id}`}
						height="100%"
						language={language}
						original={originalContent}
						modified={isDeleted ? "" : currentContent || ""}
						theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
						beforeMount={(monaco) => {
							// Disable TypeScript/JavaScript validation
							monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(
								{
									noSemanticValidation: true,
									noSyntaxValidation: false, // Keep syntax highlighting
								},
							);
							monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(
								{
									noSemanticValidation: true,
									noSyntaxValidation: false, // Keep syntax highlighting
								},
							);
						}}
						options={{
							readOnly: true,
							renderSideBySide: true,
							minimap: { enabled: false },
							scrollBeyondLastLine: false,
							fontSize: 13,
							lineNumbers: "on",
							renderLineHighlight: "all",
							scrollbar: {
								verticalScrollbarSize: 10,
								horizontalScrollbarSize: 10,
							},
							// Collapse unchanged regions for easier navigation
							hideUnchangedRegions: {
								enabled: true,
								minimumLineCount: 3,
								contextLineCount: 3,
								revealLineCount: 0, // Start with regions collapsed
							},
							diffWordWrap: "on",
						}}
					/>
				</Suspense>
			</div>
		</div>
	);
}

function FileContentView({
	content: serverContent,
	filePath,
	isServerLoading,
	onBackToDiff,
}: {
	content: string;
	filePath: string;
	isServerLoading?: boolean;
	/** Callback to return to diff view (undefined if no diff available) */
	onBackToDiff?: () => void;
}) {
	const { selectedSession } = useSessionViewContext();
	const { resolvedTheme } = useTheme();
	const { mutate } = useSWRConfig();
	const language = getLanguageFromPath(filePath);

	const { state, handleEdit, save, acceptServerContent, forceSave, discard } =
		useFileEdit(
			selectedSession?.id ?? null,
			filePath,
			serverContent,
			isServerLoading ?? false,
		);

	// Track if conflict dialog has been dismissed (to allow continued editing)
	const [conflictDismissed, setConflictDismissed] = React.useState(false);

	// Reset dismissed state when conflict is resolved
	React.useEffect(() => {
		if (!state.hasConflict) {
			setConflictDismissed(false);
		}
	}, [state.hasConflict]);

	const handleEditorChange = React.useCallback(
		(value: string | undefined) => {
			if (value !== undefined) {
				handleEdit(value);
			}
		},
		[handleEdit],
	);

	const handleSave = React.useCallback(async () => {
		const success = await save();
		if (success && selectedSession?.id) {
			// Refresh diff data after successful save
			mutate(`session-diff-${selectedSession.id}-files`);
		}
	}, [save, selectedSession?.id, mutate]);

	const handleForceSave = React.useCallback(async () => {
		const success = await forceSave();
		if (success && selectedSession?.id) {
			// Refresh diff data after successful save
			mutate(`session-diff-${selectedSession.id}-files`);
		}
	}, [forceSave, selectedSession?.id, mutate]);

	const handleDiscard = React.useCallback(() => {
		discard();
	}, [discard]);

	// Keyboard shortcut for save
	React.useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				if (state.isDirty && !state.isSaving) {
					handleSave();
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [state.isDirty, state.isSaving, handleSave]);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
			{/* Editor toolbar */}
			<div className="h-8 flex items-center justify-between px-2 border-b border-border bg-muted/20 shrink-0">
				<div className="flex items-center gap-3">
					{state.isDirty && (
						<span className="text-xs text-muted-foreground">Modified</span>
					)}
					{state.saveError && !state.hasConflict && (
						<span className="text-xs text-destructive">{state.saveError}</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					{/* Back to diff button */}
					{onBackToDiff && !state.isDirty && (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-xs"
							onClick={onBackToDiff}
							title="Back to diff view"
						>
							Diff
						</Button>
					)}
					{state.isDirty && (
						<>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={handleDiscard}
								disabled={state.isSaving}
								title="Discard changes"
							>
								<RotateCcw className="h-3 w-3 mr-1" />
								Discard
							</Button>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={handleSave}
								disabled={state.isSaving}
								title="Save (Cmd+S)"
							>
								{state.isSaving ? (
									<Loader2 className="h-3 w-3 mr-1 animate-spin" />
								) : (
									<Save className="h-3 w-3 mr-1" />
								)}
								Save
							</Button>
						</>
					)}
				</div>
			</div>

			{/* Monaco Editor */}
			<div className="flex-1 overflow-hidden">
				<Editor
					key={`edit-${filePath}`}
					height="100%"
					language={language}
					value={state.content}
					onChange={handleEditorChange}
					theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
					beforeMount={(monaco) => {
						// Disable TypeScript/JavaScript validation
						monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(
							{
								noSemanticValidation: true,
								noSyntaxValidation: false, // Keep syntax highlighting
							},
						);
						monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(
							{
								noSemanticValidation: true,
								noSyntaxValidation: false, // Keep syntax highlighting
							},
						);
					}}
					options={{
						readOnly: false,
						minimap: { enabled: false },
						scrollBeyondLastLine: false,
						fontSize: 13,
						lineNumbers: "on",
						renderLineHighlight: "line",
						scrollbar: {
							verticalScrollbarSize: 10,
							horizontalScrollbarSize: 10,
						},
						padding: { top: 8 },
					}}
					loading={
						<div className="flex-1 flex items-center justify-center text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin mr-2" />
							Loading editor...
						</div>
					}
				/>
			</div>

			{/* Conflict Resolution Dialog */}
			<Dialog
				open={state.hasConflict && !conflictDismissed}
				onOpenChange={(open) => !open && setConflictDismissed(true)}
			>
				<DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-yellow-500" />
							File Modified Externally
						</DialogTitle>
						<DialogDescription>
							This file was modified while you were editing. Review the changes
							below and choose how to resolve the conflict.
						</DialogDescription>
					</DialogHeader>

					{/* Diff view showing server (left) vs local (right) */}
					<div className="flex-1 min-h-0 overflow-hidden border rounded-md">
						{state.conflictContent !== null && (
							<DiffEditor
								key={`conflict-diff-${filePath}`}
								height="100%"
								language={language}
								original={state.conflictContent}
								modified={state.content}
								theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
								beforeMount={(monaco) => {
									// Disable TypeScript/JavaScript validation
									monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(
										{
											noSemanticValidation: true,
											noSyntaxValidation: false, // Keep syntax highlighting
										},
									);
									monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(
										{
											noSemanticValidation: true,
											noSyntaxValidation: false, // Keep syntax highlighting
										},
									);
								}}
								options={{
									readOnly: true,
									renderSideBySide: true,
									minimap: { enabled: false },
									scrollBeyondLastLine: false,
									fontSize: 13,
									lineNumbers: "on",
									renderLineHighlight: "all",
									scrollbar: {
										verticalScrollbarSize: 10,
										horizontalScrollbarSize: 10,
									},
									// Collapse unchanged regions for easier navigation
									hideUnchangedRegions: {
										enabled: true,
										minimumLineCount: 3,
										contextLineCount: 3,
										revealLineCount: 0, // Start with regions collapsed
									},
									diffWordWrap: "on",
								}}
							/>
						)}
					</div>

					<DialogFooter className="flex-row justify-between sm:justify-between gap-2">
						<Button
							variant="outline"
							onClick={() => setConflictDismissed(true)}
						>
							Keep Editing
						</Button>
						<div className="flex gap-2">
							<Button variant="secondary" onClick={acceptServerContent}>
								Use Disk Version
							</Button>
							<Button onClick={handleForceSave}>
								<Save className="h-4 w-4 mr-2" />
								Save My Changes
							</Button>
						</div>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
