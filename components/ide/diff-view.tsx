import { AlertTriangle, Download, FileText, X } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { FileNode } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

// Diff size thresholds (in lines)
const DIFF_WARNING_THRESHOLD = 10000; // Show warning but allow loading
const DIFF_HARD_LIMIT = 20000; // Never render, show fallback only

/**
 * Generate a simple unified diff patch from original and current content
 */
function generateSimplePatch(
	fileName: string,
	original: string,
	current: string,
): string {
	const originalLines = original.split("\n");
	const currentLines = current.split("\n");

	let patch = `--- a/${fileName}\n+++ b/${fileName}\n`;

	const maxLines = Math.max(originalLines.length, currentLines.length);
	for (let i = 0; i < maxLines; i++) {
		const originalLine = originalLines[i];
		const currentLine = currentLines[i];

		if (originalLine !== currentLine) {
			if (originalLine !== undefined) {
				patch += `-${originalLine}\n`;
			}
			if (currentLine !== undefined) {
				patch += `+${currentLine}\n`;
			}
		} else {
			patch += ` ${currentLine}\n`;
		}
	}

	return patch;
}

interface LargeDiffFallbackProps {
	lineCount: number;
	fileName: string;
	originalContent: string;
	currentContent: string;
	canLoadAnyway: boolean;
	onLoadAnyway?: () => void;
}

function LargeDiffFallback({
	lineCount,
	fileName,
	originalContent,
	currentContent,
	canLoadAnyway,
	onLoadAnyway,
}: LargeDiffFallbackProps) {
	const handleDownloadPatch = () => {
		const patch = generateSimplePatch(
			fileName,
			originalContent,
			currentContent,
		);
		const blob = new Blob([patch], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${fileName}.patch`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleViewCurrent = () => {
		// Create a temporary file viewer (simple text display)
		const blob = new Blob([currentContent], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		window.open(url, "_blank");
		setTimeout(() => URL.revokeObjectURL(url), 1000);
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
						onClick={handleViewCurrent}
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

interface DiffViewProps {
	file: FileNode;
	onClose: () => void;
	className?: string;
}

export function DiffView({ file, onClose, className }: DiffViewProps) {
	// Track whether user wants to force load a large diff
	const [forceLoadLargeDiff, setForceLoadLargeDiff] = React.useState(false);

	// Simple diff algorithm
	// Depend on primitive strings, not arrays, to avoid unnecessary recalculations
	const diffLines = React.useMemo(() => {
		const originalLines = (file.originalContent || "").split("\n");
		const currentLines = (file.content || "").split("\n");

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
	}, [file.originalContent, file.content]);

	// Check if diff is too large to render
	const diffLineCount = diffLines.length;
	const isOverHardLimit = diffLineCount > DIFF_HARD_LIMIT;
	const isOverWarningThreshold =
		diffLineCount > DIFF_WARNING_THRESHOLD && diffLineCount <= DIFF_HARD_LIMIT;
	const shouldShowFallback =
		(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

	// Reset force load when file changes
	React.useEffect(() => {
		setForceLoadLargeDiff(false);
	}, []);

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-2 border-b border-border">
				<div className="flex items-center gap-2">
					<span className="font-medium">{file.name}</span>
					<span className="text-xs text-muted-foreground">Diff View</span>
					{forceLoadLargeDiff && (
						<span className="text-xs text-yellow-500 font-medium flex items-center gap-1">
							<AlertTriangle className="h-3 w-3" />
							Large diff ({diffLineCount.toLocaleString()} lines)
						</span>
					)}
				</div>
				<Button variant="ghost" size="icon" onClick={onClose}>
					<X className="h-4 w-4" />
				</Button>
			</div>

			{/* Show fallback UI if diff is too large */}
			{shouldShowFallback ? (
				<LargeDiffFallback
					lineCount={diffLineCount}
					fileName={file.name}
					originalContent={file.originalContent || ""}
					currentContent={file.content || ""}
					canLoadAnyway={isOverWarningThreshold && !isOverHardLimit}
					onLoadAnyway={
						isOverWarningThreshold
							? () => setForceLoadLargeDiff(true)
							: undefined
					}
				/>
			) : (
				<>
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
				</>
			)}
		</div>
	);
}
