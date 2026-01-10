"use client";

import { X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { FileNode } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

interface DiffViewProps {
	file: FileNode;
	onClose: () => void;
	className?: string;
}

export function DiffView({ file, onClose, className }: DiffViewProps) {
	const originalLines = (file.originalContent || "").split("\n");
	const currentLines = (file.content || "").split("\n");

	// Simple diff algorithm
	const diffLines = React.useMemo(() => {
		const result: {
			type: "unchanged" | "added" | "removed";
			lineNumber: number;
			content: string;
		}[] = [];

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
	}, [originalLines, currentLines]);

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-2 border-b border-border">
				<div className="flex items-center gap-2">
					<span className="font-medium">{file.name}</span>
					<span className="text-xs text-muted-foreground">Diff View</span>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose}>
					<X className="h-4 w-4" />
				</Button>
			</div>

			{/* Diff content */}
			<div className="flex-1 overflow-auto font-mono text-sm">
				<table className="w-full border-collapse">
					<tbody>
						{diffLines.map((line, idx) => (
							<tr
								key={`${line.lineNumber}-${line.type}-${idx}`}
								className={cn(
									line.type === "added" && "bg-diff-add",
									line.type === "removed" && "bg-diff-remove",
								)}
							>
								<td className="px-2 py-0.5 text-right text-muted-foreground select-none w-12 border-r border-border">
									{line.lineNumber}
								</td>
								<td className="px-2 py-0.5 w-6 select-none text-center">
									{line.type === "added" && (
										<span className="text-diff-add-line">+</span>
									)}
									{line.type === "removed" && (
										<span className="text-diff-remove-line">-</span>
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

			{/* Footer stats */}
			<div className="px-4 py-2 border-t border-border text-xs text-muted-foreground">
				<span className="text-diff-add-line mr-4">
					+{diffLines.filter((l) => l.type === "added").length} additions
				</span>
				<span className="text-diff-remove-line">
					-{diffLines.filter((l) => l.type === "removed").length} deletions
				</span>
			</div>
		</div>
	);
}
