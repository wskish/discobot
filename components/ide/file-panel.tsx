"use client";

import {
	ChevronDown,
	ChevronRight,
	FileCode,
	Files,
	Filter,
	Folder,
	FolderOpen,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { FileNode, Session } from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface FilePanelProps {
	session: Session | null;
	onFileSelect: (file: FileNode) => void;
	selectedFileId: string | null;
	className?: string;
}

// ... existing code (unchanged) ...
export function FilePanel({
	session,
	onFileSelect,
	selectedFileId,
	className,
}: FilePanelProps) {
	const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
	const [showChangedOnly, setShowChangedOnly] = React.useState(true);

	const toggleExpand = (id: string) => {
		const next = new Set(expandedIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		setExpandedIds(next);
	};

	const filterFiles = React.useCallback(
		(files: FileNode[]): FileNode[] => {
			if (!showChangedOnly) return files;

			return files.reduce<FileNode[]>((acc, file) => {
				if (file.type === "folder" && file.children) {
					const filteredChildren = filterFiles(file.children);
					if (filteredChildren.length > 0) {
						acc.push({ ...file, children: filteredChildren });
					}
				} else if (file.type === "file" && file.changed) {
					acc.push(file);
				}
				return acc;
			}, []);
		},
		[showChangedOnly],
	);

	const filteredFiles = session ? filterFiles(session.files) : [];

	const countChangedFiles = React.useCallback((files: FileNode[]): number => {
		return files.reduce((count, file) => {
			if (file.type === "folder" && file.children) {
				return count + countChangedFiles(file.children);
			}
			return count + (file.changed ? 1 : 0);
		}, 0);
	}, []);

	const changedCount = session ? countChangedFiles(session.files) : 0;

	if (!session) {
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
				{filteredFiles.length === 0 ? (
					<div className="text-muted-foreground text-sm p-4 text-center">
						{showChangedOnly ? "No changed files" : "No files"}
					</div>
				) : (
					filteredFiles.map((file) => (
						<FileTreeNode
							key={file.id}
							node={file}
							depth={0}
							expandedIds={expandedIds}
							toggleExpand={toggleExpand}
							onFileSelect={onFileSelect}
							selectedFileId={selectedFileId}
						/>
					))
				)}
			</div>
		</div>
	);
}

function FileTreeNode({
	node,
	depth,
	expandedIds,
	toggleExpand,
	onFileSelect,
	selectedFileId,
}: {
	node: FileNode;
	depth: number;
	expandedIds: Set<string>;
	toggleExpand: (id: string) => void;
	onFileSelect: (file: FileNode) => void;
	selectedFileId: string | null;
}) {
	const isExpanded = expandedIds.has(node.id);
	const isFolder = node.type === "folder";
	const isSelected = selectedFileId === node.id;

	const handleClick = () => {
		if (isFolder) {
			toggleExpand(node.id);
		} else {
			onFileSelect(node);
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
						{isExpanded ? (
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
							key={child.id}
							node={child}
							depth={depth + 1}
							expandedIds={expandedIds}
							toggleExpand={toggleExpand}
							onFileSelect={onFileSelect}
							selectedFileId={selectedFileId}
						/>
					))}
				</div>
			)}
		</div>
	);
}
