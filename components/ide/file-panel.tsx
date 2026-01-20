"use client";

import {
	ChevronDown,
	ChevronRight,
	FileCode,
	Files,
	Filter,
	Folder,
	FolderOpen,
	Loader2,
	X,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	type LazyFileNode,
	useSessionFiles,
} from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

interface FilePanelProps {
	sessionId: string | null;
	onFileSelect: (path: string) => void;
	selectedFilePath: string | null;
	className?: string;
	onCloseSession?: (saveChanges: boolean) => void;
}

export function FilePanel({
	sessionId,
	onFileSelect,
	selectedFilePath,
	className,
	onCloseSession,
}: FilePanelProps) {
	const [showChangedOnly, setShowChangedOnly] = React.useState(true);

	const {
		fileTree,
		isLoading,
		diffStats,
		changedFiles,
		expandedPaths,
		toggleDirectory,
		isPathLoading,
	} = useSessionFiles(sessionId, !showChangedOnly);

	// Filter to show only changed files when in "Changed" mode
	const filterFiles = React.useCallback(
		(nodes: LazyFileNode[]): LazyFileNode[] => {
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
		},
		[showChangedOnly, changedFiles],
	);

	const filteredFiles = filterFiles(fileTree);
	const changedCount = diffStats?.filesChanged ?? changedFiles.length;

	if (!sessionId) {
		return (
			<div
				className={cn(
					"flex flex-col h-full bg-sidebar border-l border-border",
					className,
				)}
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
		>
			<div className="px-3 py-2 border-b border-sidebar-border flex items-center justify-between">
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
						/>
					))
				)}
			</div>

			{/* Close Session footer */}
			{onCloseSession && (
				<div className="px-3 py-2 border-t border-sidebar-border">
					{changedCount > 0 ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="w-full gap-2 text-xs"
								>
									<X className="h-3.5 w-3.5" />
									Close Session
									<ChevronDown className="h-3 w-3 ml-auto opacity-50" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-48">
								<DropdownMenuItem onSelect={() => onCloseSession(true)}>
									Close & Push Changes
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={() => onCloseSession(false)}>
									Close without Saving
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : (
						<Button
							variant="outline"
							size="sm"
							className="w-full gap-2 text-xs"
							onClick={() => onCloseSession(false)}
						>
							<X className="h-3.5 w-3.5" />
							Close Session
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

function FileTreeNode({
	node,
	depth,
	expandedPaths,
	toggleExpand,
	onFileSelect,
	selectedFilePath,
	isPathLoading,
}: {
	node: LazyFileNode;
	depth: number;
	expandedPaths: Set<string>;
	toggleExpand: (path: string) => void;
	onFileSelect: (path: string) => void;
	selectedFilePath: string | null;
	isPathLoading: (path: string) => boolean;
}) {
	const isExpanded = expandedPaths.has(node.path);
	const isFolder = node.type === "directory";
	const isSelected = selectedFilePath === node.path;
	const isLoading = isPathLoading(node.path);

	const handleClick = () => {
		if (isFolder) {
			toggleExpand(node.path);
		} else {
			onFileSelect(node.path);
		}
	};

	return (
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
						{isExpanded ? (
							<FolderOpen className="h-4 w-4 text-amber-500" />
						) : (
							<Folder className="h-4 w-4 text-amber-500" />
						)}
					</>
				) : (
					<>
						<span className="w-3.5" />
						<FileCode
							className={cn(
								"h-4 w-4",
								node.changed ? "text-green-500" : "text-sky-500",
							)}
						/>
					</>
				)}
				<span className="truncate">{node.name}</span>
				{node.changed && node.type === "file" && (
					<span className="ml-auto text-xs text-green-500 font-medium">M</span>
				)}
			</button>
			{isFolder && isExpanded && node.children && (
				<div>
					{node.children.map((child) => (
						<FileTreeNode
							key={child.path}
							node={child}
							depth={depth + 1}
							expandedPaths={expandedPaths}
							toggleExpand={toggleExpand}
							onFileSelect={onFileSelect}
							selectedFilePath={selectedFilePath}
							isPathLoading={isPathLoading}
						/>
					))}
				</div>
			)}
		</div>
	);
}
