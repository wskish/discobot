import * as Diff from "diff";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { lazy, Suspense } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
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

// Lazy-load Monaco DiffEditor
const DiffEditor = lazy(() =>
	import("@monaco-editor/react").then((mod) => ({ default: mod.DiffEditor })),
);

// Language detection from file path
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
	const filename = filePath.split("/").pop()?.toLowerCase() || "";
	if (filename === "dockerfile") return "dockerfile";
	if (filename === "makefile") return "makefile";
	if (filename.startsWith(".") && !ext) return "plaintext";
	return LANGUAGE_MAP[ext] || "plaintext";
}

/**
 * Reconstruct original content from current content and unified diff patch.
 */
function reconstructOriginalFromPatch(
	currentContent: string,
	patch: string,
): string {
	try {
		const parsedPatches = Diff.parsePatch(patch);
		if (parsedPatches.length === 0) {
			return currentContent;
		}

		const reversedPatch = parsedPatches[0];
		const originalPatch = {
			...reversedPatch,
			hunks: reversedPatch.hunks.map((hunk) => ({
				...hunk,
				lines: hunk.lines.map((line: string) => {
					if (line.startsWith("+")) return `-${line.slice(1)}`;
					if (line.startsWith("-")) return `+${line.slice(1)}`;
					return line;
				}),
				oldStart: hunk.newStart,
				oldLines: hunk.newLines,
				newStart: hunk.oldStart,
				newLines: hunk.oldLines,
			})),
		};

		const result = Diff.applyPatch(currentContent, originalPatch);
		return typeof result === "string" ? result : currentContent;
	} catch (error) {
		console.error("Failed to reconstruct original from patch:", error);
		return currentContent;
	}
}

interface FileDiffSectionProps {
	filePath: string;
	sessionId: string;
	isExpanded: boolean;
	isReviewed: boolean;
	onToggleExpand: () => void;
	onToggleReview: () => void;
}

/**
 * Individual file diff section with collapsible Monaco DiffEditor
 */
function FileDiffSection({
	filePath,
	sessionId,
	isExpanded,
	isReviewed,
	onToggleExpand,
	onToggleReview,
}: FileDiffSectionProps) {
	const { resolvedTheme } = useTheme();

	const {
		diff,
		isLoading: isDiffLoading,
		error: diffError,
	} = useSessionFileDiff(sessionId, filePath);

	const isDeleted = diff?.status === "deleted";
	const isAdded = diff?.status === "added";

	// For deleted files, we need to fetch from base commit
	// For other files, load current content
	const shouldLoadContent = !isDiffLoading && !!diff && !diff.binary;

	// Load content from base for deleted files, from current workspace otherwise
	const [deletedFileContent, setDeletedFileContent] = React.useState<
		string | null
	>(null);
	const [deletedFileLoading, setDeletedFileLoading] = React.useState(false);
	const [deletedFileError, setDeletedFileError] = React.useState<Error | null>(
		null,
	);

	// Fetch deleted file content from base commit
	React.useEffect(() => {
		if (isDeleted && shouldLoadContent && sessionId && filePath) {
			setDeletedFileLoading(true);
			setDeletedFileError(null);
			api
				.readSessionFile(sessionId, filePath, { fromBase: true })
				.then((result) => {
					setDeletedFileContent(result.content || "");
					setDeletedFileLoading(false);
				})
				.catch((err) => {
					setDeletedFileError(err);
					setDeletedFileLoading(false);
				});
		}
	}, [isDeleted, shouldLoadContent, sessionId, filePath]);

	const {
		content: currentContent,
		isLoading: isContentLoading,
		error: contentError,
	} = useSessionFileContent(
		shouldLoadContent && !isDeleted ? sessionId : null,
		filePath,
	);

	// Reconstruct original content from patch
	const originalContent = React.useMemo(() => {
		if (isAdded) return "";
		if (isDeleted) return deletedFileContent || "";
		if (!currentContent || !diff?.patch) return "";
		return reconstructOriginalFromPatch(currentContent, diff.patch);
	}, [currentContent, diff?.patch, isAdded, isDeleted, deletedFileContent]);

	const language = getLanguageFromPath(filePath);

	// Handle review - auto-collapse when marked as reviewed
	const handleReviewClick = () => {
		onToggleReview();
		if (!isReviewed && isExpanded) {
			// Collapse when marking as reviewed
			onToggleExpand();
		}
	};

	const isLoading =
		isDiffLoading ||
		(shouldLoadContent && (isDeleted ? deletedFileLoading : isContentLoading));
	const finalError = diffError || (isDeleted ? deletedFileError : contentError);

	return (
		<div className="border-b border-border">
			{/* File header - always visible */}
			<div
				className={cn(
					"flex items-center justify-between px-4 py-2 bg-muted/20",
					isReviewed && "opacity-60",
				)}
			>
				<button
					type="button"
					className="flex items-center gap-2 flex-1 min-w-0 hover:opacity-80 transition-opacity"
					onClick={onToggleExpand}
				>
					{isExpanded ? (
						<ChevronDown className="h-4 w-4 shrink-0" />
					) : (
						<ChevronRight className="h-4 w-4 shrink-0" />
					)}
					<span className="font-mono text-sm truncate">{filePath}</span>
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
				</button>
				<Button
					variant={isReviewed ? "secondary" : "ghost"}
					size="sm"
					className="h-6 px-2 text-xs shrink-0"
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

			{/* Expandable diff content */}
			{isExpanded && (
				<div className="bg-background">
					{isLoading ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							<Loader2 className="h-5 w-5 animate-spin mr-2" />
							Loading diff...
						</div>
					) : finalError ? (
						<div className="flex items-center justify-center py-8 text-destructive">
							Failed to load: {finalError.message}
						</div>
					) : !diff || !diff.patch ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							No diff available
						</div>
					) : diff.binary ? (
						<div className="flex items-center justify-center py-8 text-muted-foreground">
							Binary file - cannot display diff
						</div>
					) : (
						<div style={{ height: "400px" }}>
							<Suspense
								fallback={
									<div className="flex items-center justify-center h-full text-muted-foreground">
										<Loader2 className="h-5 w-5 animate-spin mr-2" />
										Loading editor...
									</div>
								}
							>
								<DiffEditor
									height="100%"
									language={language}
									original={originalContent}
									modified={isDeleted ? "" : currentContent || ""}
									theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
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
										hideUnchangedRegions: {
											enabled: true,
											minimumLineCount: 3,
											contextLineCount: 3,
											revealLineCount: 0,
										},
										diffWordWrap: "on",
									}}
								/>
							</Suspense>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Consolidated diff view showing all changed files in a GitHub-style stacked layout.
 * Each file is collapsible and can be marked as reviewed (persisted in localStorage).
 */
export function ConsolidatedDiffView() {
	const { selectedSessionId } = useSessionViewContext();

	// Get all changed files from session
	const { diffEntries, isLoading: isLoadingFiles } = useSessionFiles(
		selectedSessionId,
		false,
	);

	// Track expanded/collapsed state per file (in sessionStorage)
	// Note: Using arrays instead of Sets because Sets don't survive JSON serialization
	const [expandedFiles, setExpandedFiles] = usePersistedState<string[]>(
		STORAGE_KEYS.CONSOLIDATED_DIFF_EXPANDED,
		[],
		"session",
	);

	// Track reviewed state per session+file (in localStorage)
	const [reviewedFiles, setReviewedFiles] = usePersistedState<
		Record<string, string[]>
	>(STORAGE_KEYS.CONSOLIDATED_DIFF_REVIEWED, {}, "local");

	const sessionReviewedFiles = React.useMemo(
		() => new Set(reviewedFiles[selectedSessionId || ""] || []),
		[reviewedFiles, selectedSessionId],
	);

	const expandedFilesSet = React.useMemo(
		() => new Set(expandedFiles),
		[expandedFiles],
	);

	const toggleExpanded = React.useCallback(
		(filePath: string) => {
			setExpandedFiles((prev) => {
				const set = new Set(prev);
				if (set.has(filePath)) {
					set.delete(filePath);
				} else {
					set.add(filePath);
				}
				return Array.from(set);
			});
		},
		[setExpandedFiles],
	);

	const toggleReviewed = React.useCallback(
		(filePath: string) => {
			if (!selectedSessionId) return;

			setReviewedFiles((prev) => {
				const sessionFiles = new Set(prev[selectedSessionId] || []);

				if (sessionFiles.has(filePath)) {
					sessionFiles.delete(filePath);
				} else {
					sessionFiles.add(filePath);
				}

				return {
					...prev,
					[selectedSessionId]: Array.from(sessionFiles),
				};
			});
		},
		[selectedSessionId, setReviewedFiles],
	);

	const expandAll = React.useCallback(() => {
		const allPaths = diffEntries.map((f) => f.path);
		setExpandedFiles(allPaths);
	}, [diffEntries, setExpandedFiles]);

	const collapseAll = React.useCallback(() => {
		setExpandedFiles([]);
	}, [setExpandedFiles]);

	const markAllReviewed = React.useCallback(() => {
		if (!selectedSessionId) return;
		const allPaths = diffEntries.map((f) => f.path);
		setReviewedFiles((prev) => ({
			...prev,
			[selectedSessionId]: allPaths,
		}));
		// Also collapse all when marking all as reviewed
		setExpandedFiles([]);
	}, [selectedSessionId, diffEntries, setReviewedFiles, setExpandedFiles]);

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

	const allExpanded = diffEntries.every((f) => expandedFilesSet.has(f.path));
	const allReviewed = diffEntries.every((f) =>
		sessionReviewedFiles.has(f.path),
	);

	return (
		<div className="flex-1 flex flex-col overflow-hidden">
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
					<Button
						variant="ghost"
						size="sm"
						className="h-6 text-xs"
						onClick={allExpanded ? collapseAll : expandAll}
					>
						{allExpanded ? "Collapse All" : "Expand All"}
					</Button>
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
			<div className="flex-1 overflow-y-auto">
				{diffEntries.map((file) => (
					<FileDiffSection
						key={file.path}
						filePath={file.path}
						sessionId={selectedSessionId}
						isExpanded={expandedFilesSet.has(file.path)}
						isReviewed={sessionReviewedFiles.has(file.path)}
						onToggleExpand={() => toggleExpanded(file.path)}
						onToggleReview={() => toggleReviewed(file.path)}
					/>
				))}
			</div>
		</div>
	);
}
