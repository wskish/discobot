import { PatchDiff } from "@pierre/diffs/react";
import {
	Check,
	ChevronDown,
	ChevronRight,
	Columns2,
	Edit,
	Loader2,
	Rows2,
} from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import {
	useSessionFileDiff,
	useSessionFiles,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

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

	const {
		diff,
		isLoading: isDiffLoading,
		error: diffError,
	} = useSessionFileDiff(sessionId, filePath);

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

	// Handle review - auto-collapse when marked as reviewed
	const handleReviewClick = () => {
		if (patchHash) {
			onToggleReview(patchHash);
			if (!isReviewed && isExpanded) {
				// Collapse when marking as reviewed
				onToggleExpand();
			}
		}
	};

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
				</button>
				<div className="flex items-center gap-1 shrink-0">
					{/* Edit button - only show for non-deleted files */}
					{diff?.status !== "deleted" && (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-xs"
							onClick={(e) => {
								e.stopPropagation();
								onEdit();
							}}
							title="Edit file"
						>
							<Edit className="h-3 w-3 mr-1" />
							Edit
						</Button>
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
				<div className="bg-background">
					{isDiffLoading ? (
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
					) : (
						<PatchDiff
							patch={diff.patch}
							options={{
								theme: {
									dark: "github-dark",
									light: "github-light",
								},
								themeType: resolvedTheme === "dark" ? "dark" : "light",
								diffStyle,
								lineDiffType: "word-alt",
							}}
						/>
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

	// Track expanded/collapsed state per file (in sessionStorage)
	// Note: Using arrays instead of Sets because Sets don't survive JSON serialization
	const [expandedFiles, setExpandedFiles] = usePersistedState<string[]>(
		STORAGE_KEYS.CONSOLIDATED_DIFF_EXPANDED,
		[],
		"session",
	);

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
		(filePath: string, patchHash: string) => {
			if (!selectedSessionId) return;

			setReviewedFiles((prev) => {
				const sessionFiles = { ...(prev[selectedSessionId] || {}) };

				// If already reviewed with this exact hash, unmark it
				// Otherwise, mark as reviewed with the new hash
				if (sessionFiles[filePath] === patchHash) {
					delete sessionFiles[filePath];
				} else {
					sessionFiles[filePath] = patchHash;
				}

				return {
					...prev,
					[selectedSessionId]: sessionFiles,
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
		// Also collapse all when marking all as reviewed
		setExpandedFiles([]);
	}, [selectedSessionId, diffEntries, setReviewedFiles, setExpandedFiles]);

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

	const allExpanded = diffEntries.every((f) => expandedFilesSet.has(f.path));
	// Note: We can't easily check if all are reviewed with current hashes without loading all diffs
	// So we just check if all file paths have a stored hash (may be outdated)
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
