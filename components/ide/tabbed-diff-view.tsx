"use client";

import Editor from "@monaco-editor/react";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import {
	AlertTriangle,
	Columns2,
	FileCode,
	FileMinus,
	FilePlus,
	Loader2,
	Pencil,
	RotateCcw,
	Rows2,
	Save,
	X,
} from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import { useSWRConfig } from "swr";
import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
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
import { useSessionContext } from "@/lib/contexts/session-context";
import { useFileEdit } from "@/lib/hooks/use-file-edit";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import {
	useSessionFileContent,
	useSessionFileDiff,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

type DiffStyle = "unified" | "split";
type ViewMode = "diff" | "edit";

interface TabbedDiffViewProps {
	openFiles: FileNode[];
	activeFileId: string | null;
	onTabSelect: (file: FileNode) => void;
	onTabClose: (fileId: string) => void;
	panelState: PanelState;
	onMaximize: () => void;
	onClose: () => void;
	className?: string;
	hideEmptyState?: boolean;
}

export function TabbedDiffView({
	openFiles,
	activeFileId,
	onTabSelect,
	onTabClose,
	panelState,
	onMaximize,
	onClose,
	className,
	hideEmptyState,
}: TabbedDiffViewProps) {
	const [diffStyle, setDiffStyle] = usePersistedState<DiffStyle>(
		STORAGE_KEYS.DIFF_STYLE,
		"split",
	);

	// Persist view modes per file (diff vs edit) in sessionStorage
	const [viewModes, setViewModes] = usePersistedState<Record<string, ViewMode>>(
		STORAGE_KEYS.FILE_VIEW_MODES,
		{},
		"session",
	);

	const activeFile = openFiles.find((f) => f.id === activeFileId);

	// Get/set view mode for a specific file
	const getViewMode = React.useCallback(
		(fileId: string): ViewMode => viewModes[fileId] ?? "diff",
		[viewModes],
	);

	const setViewMode = React.useCallback(
		(fileId: string, mode: ViewMode) => {
			setViewModes((prev) => ({ ...prev, [fileId]: mode }));
		},
		[setViewModes],
	);

	if (openFiles.length === 0 && !hideEmptyState) {
		return (
			<div className={cn("flex flex-col h-full bg-background", className)}>
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					Click a file to view
				</div>
			</div>
		);
	}

	if (openFiles.length === 0) {
		return null;
	}

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{/* Header: FILES label, tabs, diff toggle, panel controls */}
			<div className="h-10 flex items-center border-b border-border bg-muted/30 shrink-0">
				{/* FILES label */}
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground px-3 shrink-0">
					Files
				</span>

				{/* Tabs */}
				<div className="flex items-center overflow-x-auto flex-1 h-full">
					{openFiles.map((file) => (
						<div
							key={file.id}
							role="tab"
							tabIndex={0}
							aria-selected={activeFileId === file.id}
							className={cn(
								"flex items-center gap-2 px-3 h-full border-r border-border cursor-pointer transition-colors text-sm shrink-0",
								activeFileId === file.id
									? "bg-background text-foreground"
									: "text-muted-foreground hover:bg-muted/50",
							)}
							onClick={() => onTabSelect(file)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									onTabSelect(file);
								}
							}}
						>
							{file.status === "deleted" ? (
								<FileMinus className="h-4 w-4 text-red-500" />
							) : file.status === "added" ? (
								<FilePlus className="h-4 w-4 text-green-500" />
							) : (
								<FileCode
									className={cn(
										"h-4 w-4",
										file.status === "modified"
											? "text-yellow-500"
											: file.changed
												? "text-yellow-500"
												: "text-sky-500",
									)}
								/>
							)}
							<span
								className={cn(
									"truncate max-w-32",
									file.status === "deleted" &&
										"line-through text-muted-foreground",
								)}
							>
								{file.name}
							</span>
							{file.status && (
								<span
									className={cn(
										"text-xs font-medium",
										file.status === "added" && "text-green-500",
										file.status === "modified" && "text-yellow-500",
										file.status === "deleted" && "text-red-500",
										file.status === "renamed" && "text-purple-500",
									)}
								>
									{file.status === "added"
										? "A"
										: file.status === "modified"
											? "M"
											: file.status === "deleted"
												? "D"
												: file.status === "renamed"
													? "R"
													: ""}
								</span>
							)}
							<button
								type="button"
								onClick={(e) => {
									e.stopPropagation();
									onTabClose(file.id);
								}}
								className="hover:bg-muted-foreground/20 rounded p-0.5 transition-colors"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					))}
				</div>

				{/* Panel controls */}
				<div className="flex items-center gap-2 px-2 shrink-0">
					<PanelControls
						state={panelState}
						onMaximize={onMaximize}
						onClose={onClose}
						showClose
						showMinimize={false}
					/>
				</div>
			</div>

			{/* Diff content */}
			{activeFile && (
				<DiffContent
					file={activeFile}
					diffStyle={diffStyle}
					onDiffStyleChange={setDiffStyle}
					viewMode={getViewMode(activeFile.id)}
					onViewModeChange={(mode) => setViewMode(activeFile.id, mode)}
				/>
			)}
		</div>
	);
}

function DiffContent({
	file,
	diffStyle,
	onDiffStyleChange,
	viewMode,
	onViewModeChange,
}: {
	file: FileNode;
	diffStyle: DiffStyle;
	onDiffStyleChange: (style: DiffStyle) => void;
	viewMode: ViewMode;
	onViewModeChange: (mode: ViewMode) => void;
}) {
	const { selectedSession } = useSessionContext();
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

	// Load current file content (for edit mode and when no diff available)
	// Don't load content for deleted files
	const shouldLoadContent =
		!isDeleted && (viewMode === "edit" || noDiffAvailable);
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
				onBackToDiff={
					!noDiffAvailable ? () => onViewModeChange("diff") : undefined
				}
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

	return (
		<div className="flex-1 overflow-auto">
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
				renderHeaderMetadata={() => (
					<div className="flex items-center gap-2 ml-auto">
						{/* Show status badge */}
						{file.status === "added" && (
							<span className="text-xs text-green-500 font-medium">
								New File
							</span>
						)}
						{isDeleted && (
							<span className="text-xs text-red-500 font-medium">
								File Deleted
							</span>
						)}
						{file.status === "renamed" && (
							<span className="text-xs text-purple-500 font-medium">
								Renamed
							</span>
						)}
						{/* Diff style toggle */}
						<div className="flex items-center rounded-md border border-border bg-background">
							<Button
								variant="ghost"
								size="sm"
								className={cn(
									"h-6 px-1.5 rounded-r-none",
									diffStyle === "split" && "bg-muted",
								)}
								onClick={() => onDiffStyleChange("split")}
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
								onClick={() => onDiffStyleChange("unified")}
								title="Unified"
							>
								<Rows2 className="h-3.5 w-3.5" />
							</Button>
						</div>
						{/* Show Edit button for non-deleted files */}
						{!isDeleted && (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => onViewModeChange("edit")}
								title="Edit file"
							>
								<Pencil className="h-3 w-3 mr-1" />
								Edit
							</Button>
						)}
					</div>
				)}
			/>
		</div>
	);
}

function getLanguageFromPath(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() || "";
	const languageMap: Record<string, string> = {
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

	// Check for special filenames
	const filename = filePath.split("/").pop()?.toLowerCase() || "";
	if (filename === "dockerfile") return "dockerfile";
	if (filename === "makefile") return "makefile";
	if (filename.startsWith(".") && !ext) return "plaintext";

	return languageMap[ext] || "plaintext";
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
	const { selectedSession } = useSessionContext();
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
							<Rows2 className="h-3 w-3 mr-1" />
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
					height="100%"
					language={language}
					value={state.content}
					onChange={handleEditorChange}
					theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
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
					<div className="flex-1 min-h-0 overflow-auto border rounded-md">
						{state.conflictContent !== null && (
							<MultiFileDiff
								oldFile={{
									name: `${filePath} (on disk)`,
									contents: state.conflictContent,
									lang: language as
										| "typescript"
										| "javascript"
										| "go"
										| "python"
										| "rust"
										| "java"
										| "css"
										| "html"
										| "json"
										| "yaml"
										| "markdown"
										| "bash"
										| "sql"
										| undefined,
								}}
								newFile={{
									name: `${filePath} (your changes)`,
									contents: state.content,
									lang: language as
										| "typescript"
										| "javascript"
										| "go"
										| "python"
										| "rust"
										| "java"
										| "css"
										| "html"
										| "json"
										| "yaml"
										| "markdown"
										| "bash"
										| "sql"
										| undefined,
								}}
								options={{
									theme: {
										dark: "github-dark",
										light: "github-light",
									},
									themeType: resolvedTheme === "dark" ? "dark" : "light",
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
