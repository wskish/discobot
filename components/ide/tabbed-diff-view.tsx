"use client";

import Editor from "@monaco-editor/react";
import { PatchDiff } from "@pierre/diffs/react";
import {
	AlertTriangle,
	Columns2,
	FileCode,
	Loader2,
	Pencil,
	RotateCcw,
	Rows2,
	Save,
	X,
} from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { FileNode } from "@/lib/api-types";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useFileEdit } from "@/lib/hooks/use-file-edit";
import {
	useSessionFileContent,
	useSessionFileDiff,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

type DiffStyle = "unified" | "split";

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
	const [diffStyle, setDiffStyle] = React.useState<DiffStyle>("split");
	const activeFile = openFiles.find((f) => f.id === activeFileId);

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
							<FileCode
								className={cn(
									"h-4 w-4",
									file.changed ? "text-green-500" : "text-sky-500",
								)}
							/>
							<span className="truncate max-w-32">{file.name}</span>
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

				{/* Diff style toggle */}
				<div className="flex items-center gap-2 px-2 shrink-0">
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

					{/* Panel controls */}
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
			{activeFile && <DiffContent file={activeFile} diffStyle={diffStyle} />}
		</div>
	);
}

type ViewMode = "diff" | "edit";

function DiffContent({
	file,
	diffStyle,
}: {
	file: FileNode;
	diffStyle: DiffStyle;
}) {
	const { selectedSession } = useSessionContext();
	const { resolvedTheme } = useTheme();
	const [viewMode, setViewMode] = React.useState<ViewMode>("diff");

	const {
		diff,
		isLoading: isDiffLoading,
		error: diffError,
	} = useSessionFileDiff(
		selectedSession?.id ?? null,
		file.id, // file.id is the file path
	);

	// Check if we should show file content instead of diff (no diff available)
	const noDiffAvailable =
		!isDiffLoading && (!diff || diff.status === "unchanged");

	// Load current file content (for edit mode and when no diff available)
	const shouldLoadContent = viewMode === "edit" || noDiffAvailable;
	const {
		content: currentContent,
		isLoading: isContentLoading,
		error: contentError,
	} = useSessionFileContent(
		shouldLoadContent ? (selectedSession?.id ?? null) : null,
		shouldLoadContent ? file.id : null,
	);

	// Reset to diff view when file changes (if diff is available)
	React.useEffect(() => {
		if (!noDiffAvailable) {
			setViewMode("diff");
		}
	}, [noDiffAvailable]);

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
				onBackToDiff={!noDiffAvailable ? () => setViewMode("diff") : undefined}
				diffStats={
					diff
						? { additions: diff.additions, deletions: diff.deletions }
						: undefined
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
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs ml-auto"
						onClick={() => setViewMode("edit")}
						title="Edit file"
					>
						<Pencil className="h-3 w-3 mr-1" />
						Edit
					</Button>
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
	diffStats,
}: {
	content: string;
	filePath: string;
	isServerLoading?: boolean;
	/** Callback to return to diff view (undefined if no diff available) */
	onBackToDiff?: () => void;
	/** Diff stats to show in toolbar when available */
	diffStats?: { additions: number; deletions: number };
}) {
	const { selectedSession } = useSessionContext();
	const { resolvedTheme } = useTheme();
	const language = getLanguageFromPath(filePath);

	const { state, handleEdit, save, acceptServerContent, forceSave, discard } =
		useFileEdit(
			selectedSession?.id ?? null,
			filePath,
			serverContent,
			isServerLoading ?? false,
		);

	const handleEditorChange = React.useCallback(
		(value: string | undefined) => {
			if (value !== undefined) {
				handleEdit(value);
			}
		},
		[handleEdit],
	);

	const handleSave = React.useCallback(async () => {
		await save();
	}, [save]);

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
					{/* Show diff stats if available */}
					{diffStats && (
						<>
							<span className="text-xs font-medium text-green-600">
								+{diffStats.additions}
							</span>
							<span className="text-xs font-medium text-red-500">
								-{diffStats.deletions}
							</span>
						</>
					)}
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

			{/* Conflict Dialog */}
			<AlertDialog open={state.hasConflict}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="flex items-center gap-2">
							<AlertTriangle className="h-5 w-5 text-yellow-500" />
							File Modified Externally
						</AlertDialogTitle>
						<AlertDialogDescription>
							This file has been modified by another process. Your local changes
							may conflict with the remote version.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel onClick={acceptServerContent}>
							Reload File
						</AlertDialogCancel>
						<AlertDialogAction onClick={forceSave}>
							Overwrite Remote
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
