"use client";

import { FileCode, X } from "lucide-react";
import * as React from "react";
import type { FileNode } from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface TabbedDiffViewProps {
	openFiles: FileNode[];
	activeFileId: string | null;
	onTabSelect: (file: FileNode) => void;
	onTabClose: (fileId: string) => void;
	className?: string;
	hideEmptyState?: boolean;
}

export function TabbedDiffView({
	openFiles,
	activeFileId,
	onTabSelect,
	onTabClose,
	className,
	hideEmptyState,
}: TabbedDiffViewProps) {
	const activeFile = openFiles.find((f) => f.id === activeFileId);

	if (openFiles.length === 0 && !hideEmptyState) {
		return (
			<div className={cn("flex flex-col h-full bg-background", className)}>
				<div className="flex-1 flex items-center justify-center text-muted-foreground">
					Click a file to view its diff
				</div>
			</div>
		);
	}

	if (openFiles.length === 0) {
		return null;
	}

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{/* Tab bar */}
			<div className="flex items-center border-b border-border bg-muted/30 overflow-x-auto shrink-0">
				{openFiles.map((file) => (
					<div
						key={file.id}
						role="tab"
						tabIndex={0}
						aria-selected={activeFileId === file.id}
						className={cn(
							"flex items-center gap-2 px-3 py-2 border-r border-border cursor-pointer transition-colors text-sm shrink-0",
							activeFileId === file.id
								? "bg-background text-foreground"
								: "bg-muted/50 text-muted-foreground hover:bg-muted",
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

			{/* Diff content */}
			{activeFile && <DiffContent file={activeFile} />}
		</div>
	);
}

function DiffContent({ file }: { file: FileNode }) {
	const originalLines = (file.originalContent || file.content || "").split(
		"\n",
	);
	const currentLines = (file.content || "").split("\n");

	const diffLines = React.useMemo(() => {
		const result: {
			type: "unchanged" | "added" | "removed";
			lineNumber: number;
			content: string;
		}[] = [];

		if (!file.originalContent) {
			return currentLines.map((line, i) => ({
				type: "unchanged" as const,
				lineNumber: i + 1,
				content: line,
			}));
		}

		const maxLines = Math.max(originalLines.length, currentLines.length);

		for (let i = 0; i < maxLines; i++) {
			const original = originalLines[i];
			const current = currentLines[i];

			if (original === undefined && current !== undefined) {
				result.push({ type: "added", lineNumber: i + 1, content: current });
			} else if (original !== undefined && current === undefined) {
				result.push({ type: "removed", lineNumber: i + 1, content: original });
			} else if (original !== current) {
				result.push({
					type: "removed",
					lineNumber: i + 1,
					content: original || "",
				});
				result.push({
					type: "added",
					lineNumber: i + 1,
					content: current || "",
				});
			} else {
				result.push({
					type: "unchanged",
					lineNumber: i + 1,
					content: current || "",
				});
			}
		}

		return result;
	}, [originalLines, currentLines, file.originalContent]);

	return (
		<>
			<div className="flex-1 overflow-auto font-mono text-sm">
				<table className="w-full border-collapse">
					<tbody>
						{diffLines.map((line, idx) => (
							<tr
								key={`${line.lineNumber}-${line.type}-${idx}`}
								className={cn(
									line.type === "added" && "bg-green-500/10",
									line.type === "removed" && "bg-red-500/10",
								)}
							>
								<td className="px-2 py-0.5 text-right text-muted-foreground select-none w-12 border-r border-border">
									{line.lineNumber}
								</td>
								<td className="px-2 py-0.5 w-6 select-none text-center">
									{line.type === "added" && (
										<span className="text-green-500">+</span>
									)}
									{line.type === "removed" && (
										<span className="text-red-500">-</span>
									)}
								</td>
								<td className="px-2 py-0.5 whitespace-pre">
									{line.content || "\u00A0"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
				<span className="text-green-500 mr-4">
					+{diffLines.filter((l) => l.type === "added").length} additions
				</span>
				<span className="text-red-500">
					-{diffLines.filter((l) => l.type === "removed").length} deletions
				</span>
			</div>
		</>
	);
}
