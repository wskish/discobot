import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import * as Diff from "diff";
import {
	CheckCircle,
	ChevronDown,
	ChevronRight,
	FileEdit,
	XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type EditToolInput,
	type EditToolOutput,
	validateEditInput,
	validateEditOutput,
} from "../tool-schemas/edit-schema";
import { shortenPath } from "./index";

/**
 * Renders a diff view using @pierre/diffs
 */
function DiffView({
	oldString,
	newString,
	fileName,
	isStreaming,
}: {
	oldString: string;
	newString: string;
	fileName: string;
	isStreaming: boolean;
}) {
	const fileDiff = useMemo(() => {
		// During streaming, defer expensive diff calculation to avoid infinite loops
		// This prevents React from entering an update cycle while the input is changing
		if (isStreaming) {
			return null;
		}

		// Create a unified diff patch using the diff library
		const patch = Diff.createPatch(
			fileName,
			oldString,
			newString,
			"original",
			"modified",
		);

		// Parse the patch using @pierre/diffs
		const parsedPatches = parsePatchFiles(patch);

		// Return the first file diff (there should only be one)
		return parsedPatches[0]?.files[0];
	}, [oldString, newString, fileName, isStreaming]);

	if (!fileDiff) {
		return (
			<div className="rounded-md border border-border bg-muted/20 p-3 text-muted-foreground text-sm">
				{isStreaming ? "Loading changes..." : "No changes to display"}
			</div>
		);
	}

	return (
		<div className="rounded-md border border-border overflow-hidden [&_pre]:!m-0 [&_pre]:!border-0">
			<FileDiff
				fileDiff={fileDiff}
				options={{
					diffStyle: "unified",
					overflow: "wrap",
					disableFileHeader: true,
				}}
			/>
		</div>
	);
}

/**
 * EditToolRenderer - Optimized renderer for Edit tool
 *
 * Displays file edit operations with:
 * - File path
 * - Unified diff view showing changes
 * - Replacement count
 * - Success indicator
 */
export default function EditToolRenderer({
	input,
	output,
	errorText,
	state,
}: ToolRendererProps<EditToolInput, EditToolOutput>) {
	// Validate output if present (before any early returns)
	const outputValidation = output ? validateEditOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as EditToolOutput | null;

	// Check if there's an error (before any early returns)
	const hasError = !!(errorText || validOutput?.error);

	// Collapse diff by default if there's an error
	// Must be called before any early returns (hooks rule)
	const [isExpanded, setIsExpanded] = useState(!hasError);

	// Validate input
	const inputValidation = validateEditInput(input);

	if (!inputValidation.success) {
		console.warn(`Edit tool input validation failed: ${inputValidation.error}`);
		return (
			<>
				<DefaultToolInput input={input} />
				<DefaultToolOutput output={output} errorText={errorText} />
			</>
		);
	}

	// biome-ignore lint/style/noNonNullAssertion: Validated above
	const validInput = inputValidation.data!;

	// Extract file name from path
	const fileName =
		validInput.file_path.split("/").pop() || validInput.file_path;

	// Check if this tool is currently streaming
	const isStreaming =
		state === "input-streaming" || state === "input-available";

	return (
		<div className="space-y-4 p-4">
			{/* File Info Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FileEdit className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Editing File
					</h4>
				</div>

				<div className="flex flex-wrap items-center gap-2 text-sm">
					<code className="rounded bg-muted px-2 py-1 font-mono text-foreground">
						{fileName}
					</code>
					{validInput.replace_all && (
						<span className="text-muted-foreground text-xs">replace all</span>
					)}
				</div>

				<div className="font-mono text-muted-foreground text-xs">
					{shortenPath(validInput.file_path)}
				</div>
			</div>

			{/* Diff Section */}
			<div className="space-y-2">
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex items-center gap-2 hover:opacity-70 transition-opacity"
				>
					{isExpanded ? (
						<ChevronDown className="size-4 text-muted-foreground" />
					) : (
						<ChevronRight className="size-4 text-muted-foreground" />
					)}
					<h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Changes
					</h5>
				</button>
				{isExpanded && (
					<DiffView
						oldString={validInput.old_string}
						newString={validInput.new_string}
						fileName={fileName}
						isStreaming={isStreaming}
					/>
				)}
			</div>

			{/* Result Section */}
			{(validOutput || errorText) && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						{errorText || validOutput?.error ? (
							<XCircle className="size-4 text-destructive" />
						) : validOutput?.success !== false ? (
							<CheckCircle className="size-4 text-green-600 dark:text-green-400" />
						) : (
							<XCircle className="size-4 text-yellow-600 dark:text-yellow-400" />
						)}
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							{errorText || validOutput?.error ? "Error" : "Result"}
						</h4>
						{validOutput?.replacements !== undefined && (
							<span className="rounded bg-green-100 px-2 py-0.5 text-green-700 text-xs dark:bg-green-950 dark:text-green-400">
								{validOutput?.replacements}{" "}
								{validOutput?.replacements === 1
									? "replacement"
									: "replacements"}
							</span>
						)}
					</div>

					{(errorText || validOutput?.error) && (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
							{errorText || validOutput?.error}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
