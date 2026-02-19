import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	FileCode,
	FileMinus,
	FilePlus,
	Files,
	Filter,
	Folder,
	FolderMinus,
	FolderOpen,
	FolderPlus,
	Loader2,
	Pencil,
	Trash2,
	X,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api } from "@/lib/api-client";
import type { FileStatus, SessionDiffFileEntry } from "@/lib/api-types";
import {
	invalidateSessionFiles,
	type LazyFileNode,
	useSessionFiles,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

/**
 * Calculate the derived status for a folder based on its descendant files.
 * Returns: "deleted" if all descendants are deleted, "added" if all are added,
 * "modified" if there's a mix, or undefined if no changed descendants.
 */
function getFolderStatus(
	folderPath: string,
	diffEntries: SessionDiffFileEntry[],
): FileStatus | undefined {
	const prefix = folderPath === "." ? "" : `${folderPath}/`;
	const descendants = diffEntries.filter((e) =>
		folderPath === "." ? true : e.path.startsWith(prefix),
	);

	if (descendants.length === 0) return undefined;

	const allDeleted = descendants.every((e) => e.status === "deleted");
	const allAdded = descendants.every((e) => e.status === "added");

	if (allDeleted) return "deleted";
	if (allAdded) return "added";
	return "modified";
}

interface FilePanelProps {
	sessionId: string | null;
	activeView: string;
	onFileSelect: (path: string) => void;
	className?: string;
	style?: React.CSSProperties;
}

export function FilePanel({
	sessionId,
	activeView,
	onFileSelect,
	className,
	style,
}: FilePanelProps) {
	const selectedFilePath = activeView.startsWith("file:")
		? activeView.slice(5)
		: null;
	const [showChangedOnly, setShowChangedOnly] = React.useState(true);
	const [isExpandingAll, setIsExpandingAll] = React.useState(false);

	const {
		fileTree,
		isLoading,
		diffStats,
		changedFiles,
		diffEntries,
		expandedPaths,
		toggleDirectory,
		expandAll,
		collapseAll,
		isPathLoading,
		refresh,
	} = useSessionFiles(sessionId, !showChangedOnly);

	// Filter to show only changed files when in "Changed" mode
	const filteredFiles = React.useMemo(() => {
		const filterFiles = (nodes: LazyFileNode[]): LazyFileNode[] => {
			if (!showChangedOnly) return nodes;

			const changedSet = new Set(changedFiles);

			// Helper to check if a path or any of its children are changed
			const hasChangedDescendant = (path: string): boolean => {
				return changedFiles.some((f) => f === path || f.startsWith(`${path}/`));
			};

			return nodes.reduce<LazyFileNode[]>((acc, node) => {
				if (node.type === "directory") {
					// Include directory if it has changed descendants
					if (hasChangedDescendant(node.path)) {
						const filteredChildren = node.children
							? filterFiles(node.children)
							: undefined;
						acc.push({ ...node, children: filteredChildren });
					}
				} else if (changedSet.has(node.path)) {
					acc.push(node);
				}
				return acc;
			}, []);
		};

		return filterFiles(fileTree);
	}, [showChangedOnly, changedFiles, fileTree]);
	const changedCount = diffStats?.filesChanged ?? changedFiles.length;

	// Handle expand all with loading state
	const handleExpandAll = React.useCallback(async () => {
		setIsExpandingAll(true);
		try {
			await expandAll();
		} finally {
			setIsExpandingAll(false);
		}
	}, [expandAll]);

	// Check if all directories are expanded
	const allExpanded = React.useMemo(() => {
		function countDirs(nodes: LazyFileNode[]): number {
			let count = 0;
			for (const node of nodes) {
				if (node.type === "directory") {
					count++;
					if (node.children) {
						count += countDirs(node.children);
					}
				}
			}
			return count;
		}
		const dirCount = countDirs(filteredFiles);
		// Check if all dirs are in expandedPaths (minus root ".")
		return dirCount > 0 && expandedPaths.size > dirCount;
	}, [filteredFiles, expandedPaths]);

	// Check if there are any directories to expand
	const hasDirs = React.useMemo(() => {
		function hasDir(nodes: LazyFileNode[]): boolean {
			for (const node of nodes) {
				if (node.type === "directory") return true;
			}
			return false;
		}
		return hasDir(filteredFiles);
	}, [filteredFiles]);

	const handleRefresh = React.useCallback(() => {
		if (sessionId) {
			invalidateSessionFiles(sessionId);
			refresh();
		}
	}, [sessionId, refresh]);

	if (!sessionId) {
		return (
			<div
				className={cn(
					"flex flex-col h-full bg-sidebar border-l border-border",
					className,
				)}
				style={style}
			>
				<div className="px-3 py-2 border-b border-sidebar-border">
					<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Files
					</span>
				</div>
				<div className="flex-1 flex items-center justify-center text-muted-foreground text-sm p-4 text-center">
					Select a session to view files
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"flex flex-col h-full bg-sidebar border-l border-border",
				className,
			)}
			style={style}
		>
			<div className="h-10 px-3 border-b border-sidebar-border flex items-center justify-between">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Files
				</span>
				<div className="flex items-center gap-1">
					<Button
						variant={showChangedOnly ? "secondary" : "ghost"}
						size="sm"
						className="h-6 px-2 text-xs gap-1"
						onClick={() => setShowChangedOnly(true)}
					>
						<Filter className="h-3 w-3" />
						Changed ({changedCount})
					</Button>
					<Button
						variant={!showChangedOnly ? "secondary" : "ghost"}
						size="sm"
						className="h-6 px-2 text-xs gap-1"
						onClick={() => setShowChangedOnly(false)}
					>
						<Files className="h-3 w-3" />
						All
					</Button>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto py-1">
				{isLoading ? (
					<div className="flex items-center justify-center p-4">
						<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					</div>
				) : filteredFiles.length === 0 ? (
					<div className="text-muted-foreground text-sm p-4 text-center">
						{showChangedOnly ? "No changed files" : "No files"}
					</div>
				) : (
					filteredFiles.map((file) => (
						<FileTreeNode
							key={file.path}
							node={file}
							depth={0}
							expandedPaths={expandedPaths}
							toggleExpand={toggleDirectory}
							onFileSelect={onFileSelect}
							selectedFilePath={selectedFilePath}
							isPathLoading={isPathLoading}
							diffEntries={diffEntries}
							sessionId={sessionId}
							onRefresh={handleRefresh}
						/>
					))
				)}
			</div>

			{/* Expand/Collapse All button - subtle footer */}
			{hasDirs && filteredFiles.length > 0 && (
				<div className="px-3 py-1.5 border-t border-sidebar-border flex justify-center">
					<Button
						variant="ghost"
						size="sm"
						className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
						onClick={allExpanded ? collapseAll : handleExpandAll}
						disabled={isExpandingAll}
					>
						{isExpandingAll ? (
							<>
								<Loader2 className="h-3 w-3 mr-1 animate-spin" />
								Expanding...
							</>
						) : allExpanded ? (
							<>
								<ChevronsDownUp className="h-3 w-3 mr-1" />
								Collapse All
							</>
						) : (
							<>
								<ChevronsUpDown className="h-3 w-3 mr-1" />
								Expand All
							</>
						)}
					</Button>
				</div>
			)}
		</div>
	);
}

/**
 * Calculates collapsed folder info for single-child directory chains.
 * E.g., if a folder has only one child which is also a folder, they collapse together.
 * Returns the display name (e.g., "a/b/c"), the final node after collapsing,
 * and all intermediate paths that need to be expanded together.
 */
function getCollapsedFolderInfo(node: LazyFileNode): {
	displayName: string;
	finalNode: LazyFileNode;
	collapsedPaths: string[];
} {
	const collapsedPaths: string[] = [node.path];
	let current = node;
	let displayName = node.name;

	// Keep collapsing while the current node is a directory with exactly one child
	// that is also a directory
	while (
		current.type === "directory" &&
		current.children?.length === 1 &&
		current.children[0].type === "directory"
	) {
		current = current.children[0];
		collapsedPaths.push(current.path);
		displayName = `${displayName}/${current.name}`;
	}

	return {
		displayName,
		finalNode: current,
		collapsedPaths,
	};
}

function FileTreeNode({
	node,
	depth,
	expandedPaths,
	toggleExpand,
	onFileSelect,
	selectedFilePath,
	isPathLoading,
	diffEntries,
	sessionId,
	onRefresh,
}: {
	node: LazyFileNode;
	depth: number;
	expandedPaths: Set<string>;
	toggleExpand: (path: string) => void;
	onFileSelect: (path: string) => void;
	selectedFilePath: string | null;
	isPathLoading: (path: string) => boolean;
	diffEntries: SessionDiffFileEntry[];
	sessionId: string;
	onRefresh: () => void;
}) {
	const isFolder = node.type === "directory";
	const [isRenaming, setIsRenaming] = React.useState(false);
	const [editedName, setEditedName] = React.useState("");
	const inputRef = React.useRef<HTMLInputElement>(null);

	// Focus input when entering rename mode
	React.useEffect(() => {
		if (isRenaming && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isRenaming]);

	// Calculate collapsed folder info for directories
	const { displayName, finalNode, collapsedPaths } = isFolder
		? getCollapsedFolderInfo(node)
		: { displayName: node.name, finalNode: node, collapsedPaths: [] };

	// For folders, check if all paths in the collapsed chain are expanded
	const isExpanded =
		isFolder && collapsedPaths.every((p) => expandedPaths.has(p));
	const isSelected = selectedFilePath === node.path;
	const isLoading = collapsedPaths.some((p) => isPathLoading(p));

	// Calculate folder status based on descendants
	const folderStatus = isFolder
		? getFolderStatus(finalNode.path, diffEntries)
		: undefined;

	const handleClick = () => {
		if (isRenaming) return;
		if (isFolder) {
			// Toggle all collapsed paths together
			for (const path of collapsedPaths) {
				// Only toggle if needed to sync the expanded state
				const pathExpanded = expandedPaths.has(path);
				if (isExpanded ? pathExpanded : !pathExpanded) {
					toggleExpand(path);
				}
			}
		} else {
			onFileSelect(node.path);
		}
	};

	const startRename = () => {
		setEditedName(node.name);
		setIsRenaming(true);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setEditedName("");
	};

	const saveRename = async () => {
		const trimmed = editedName.trim();
		if (!trimmed || trimmed === node.name) {
			cancelRename();
			return;
		}

		// Calculate new path by replacing the last segment
		const parentPath = node.path.includes("/")
			? node.path.substring(0, node.path.lastIndexOf("/"))
			: "";
		const newPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;

		try {
			await api.renameSessionFile(sessionId, {
				oldPath: node.path,
				newPath,
			});
			onRefresh();
		} catch {
			// Rename failed — stay in rename mode so user can fix the name
		}
		setIsRenaming(false);
	};

	const handleRenameKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			saveRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	};

	const handleDelete = async () => {
		try {
			await api.deleteSessionFile(sessionId, { path: node.path });
			onRefresh();
		} catch {
			// Delete failed silently
		}
	};

	// Use the final node's children for rendering
	const childrenToRender = finalNode.children;

	const nodeContent = (
		<div>
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					"w-full flex items-center gap-1.5 px-2 py-1 text-sm transition-colors hover:bg-sidebar-accent",
					isSelected && "bg-sidebar-accent",
				)}
				style={{ paddingLeft: `${8 + depth * 12}px` }}
			>
				{isFolder ? (
					<>
						{isLoading ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
						) : isExpanded ? (
							<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
						)}
						{folderStatus === "deleted" ? (
							<FolderMinus className="h-4 w-4 text-red-500" />
						) : folderStatus === "added" ? (
							<FolderPlus className="h-4 w-4 text-green-500" />
						) : isExpanded ? (
							<FolderOpen
								className={cn(
									"h-4 w-4",
									folderStatus === "modified"
										? "text-yellow-500"
										: "text-amber-500",
								)}
							/>
						) : (
							<Folder
								className={cn(
									"h-4 w-4",
									folderStatus === "modified"
										? "text-yellow-500"
										: "text-amber-500",
								)}
							/>
						)}
					</>
				) : (
					<>
						<span className="w-3.5" />
						{node.status === "deleted" ? (
							<FileMinus className="h-4 w-4 text-red-500" />
						) : node.status === "added" ? (
							<FilePlus className="h-4 w-4 text-green-500" />
						) : (
							<FileCode
								className={cn(
									"h-4 w-4",
									node.status === "modified"
										? "text-yellow-500"
										: node.changed
											? "text-yellow-500"
											: "text-sky-500",
								)}
							/>
						)}
					</>
				)}
				{isRenaming ? (
					<>
						<input
							ref={inputRef}
							type="text"
							value={editedName}
							onChange={(e) => setEditedName(e.target.value)}
							onClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								e.stopPropagation();
								handleRenameKeyDown(e);
							}}
							onBlur={saveRename}
							className="flex-1 min-w-0 px-1 py-0 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
						/>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								saveRename();
							}}
							className="p-0.5 hover:bg-muted rounded"
						>
							<Check className="h-3 w-3" />
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								cancelRename();
							}}
							className="p-0.5 hover:bg-muted rounded"
						>
							<X className="h-3 w-3" />
						</button>
					</>
				) : (
					<>
						<span
							className={cn(
								"truncate",
								(node.status === "deleted" || folderStatus === "deleted") &&
									"line-through text-muted-foreground",
							)}
						>
							{displayName}
						</span>
						{/* File status badges */}
						{!isFolder && node.status === "added" && (
							<span className="ml-auto text-xs text-green-500 font-medium">
								A
							</span>
						)}
						{!isFolder && node.status === "modified" && (
							<span className="ml-auto text-xs text-yellow-500 font-medium">
								M
							</span>
						)}
						{!isFolder && node.status === "deleted" && (
							<span className="ml-auto text-xs text-red-500 font-medium">
								D
							</span>
						)}
						{!isFolder && node.status === "renamed" && (
							<span className="ml-auto text-xs text-purple-500 font-medium">
								R
							</span>
						)}
						{/* Folder status badges */}
						{isFolder && folderStatus === "added" && (
							<span className="ml-auto text-xs text-green-500 font-medium">
								A
							</span>
						)}
						{isFolder && folderStatus === "modified" && (
							<span className="ml-auto text-xs text-yellow-500 font-medium">
								M
							</span>
						)}
						{isFolder && folderStatus === "deleted" && (
							<span className="ml-auto text-xs text-red-500 font-medium">
								D
							</span>
						)}
					</>
				)}
			</button>
			{isFolder && isExpanded && childrenToRender && (
				<div>
					{childrenToRender.map((child) => (
						<FileTreeNode
							key={child.path}
							node={child}
							depth={depth + 1}
							expandedPaths={expandedPaths}
							toggleExpand={toggleExpand}
							onFileSelect={onFileSelect}
							selectedFilePath={selectedFilePath}
							isPathLoading={isPathLoading}
							diffEntries={diffEntries}
							sessionId={sessionId}
							onRefresh={onRefresh}
						/>
					))}
				</div>
			)}
		</div>
	);

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{nodeContent}</ContextMenuTrigger>
			<ContextMenuContent className="w-40">
				<ContextMenuItem onClick={startRename}>
					<Pencil className="h-4 w-4" />
					Rename
				</ContextMenuItem>
				<ContextMenuItem variant="destructive" onClick={handleDelete}>
					<Trash2 className="h-4 w-4" />
					Delete
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
