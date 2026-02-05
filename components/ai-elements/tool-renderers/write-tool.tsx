import { CheckCircle, FileEdit, XCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	validateWriteInput,
	validateWriteOutput,
	type WriteToolInput,
	type WriteToolOutput,
} from "../tool-schemas/write-schema";
import { shortenPath } from "./index";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * Detects programming language from file extension
 */
function detectLanguage(filePath: string) {
	const ext = filePath.split(".").pop()?.toLowerCase();
	const langMap: Record<string, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		jsx: "jsx",
		py: "python",
		go: "go",
		rs: "rust",
		java: "java",
		c: "c",
		cpp: "cpp",
		md: "markdown",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		sh: "bash",
		bash: "bash",
		css: "css",
		html: "html",
		xml: "xml",
		sql: "sql",
	};
	return langMap[ext || ""] || "text";
}

/**
 * WriteToolRenderer - Optimized renderer for Write tool
 *
 * Displays file writing operations with:
 * - File path
 * - Content preview (first 10 lines with truncation indicator)
 * - Bytes written badge
 * - Success/failure indicator
 */
export default function WriteToolRenderer({
	input,
	output,
	errorText,
	state,
}: ToolRendererProps<WriteToolInput, WriteToolOutput>) {
	// Check if streaming
	const isStreaming =
		state === "input-streaming" || state === "input-available";

	// During streaming, input may be undefined or incomplete - handle gracefully
	if (!input || typeof input !== "object") {
		return (
			<div className="p-4 text-muted-foreground text-sm">
				{isStreaming ? "Loading..." : "No input data"}
			</div>
		);
	}

	// Validate input
	const inputValidation = validateWriteInput(input);

	if (!inputValidation.success) {
		// During streaming, validation may fail due to incomplete input - don't log spam
		if (!isStreaming) {
			console.warn(
				`Write tool input validation failed: ${inputValidation.error}`,
			);
		}

		// Show loading state during streaming, fallback to generic display otherwise
		if (isStreaming) {
			return (
				<div className="p-4 text-muted-foreground text-sm">
					Loading write details...
				</div>
			);
		}

		return (
			<>
				<DefaultToolInput input={input} />
				<DefaultToolOutput output={output} errorText={errorText} />
			</>
		);
	}

	// biome-ignore lint/style/noNonNullAssertion: Validated above
	const validInput = inputValidation.data!;

	// Check if file_path and content exist
	if (!validInput.file_path || !validInput.content) {
		return (
			<div className="p-4 text-muted-foreground text-sm">
				{isStreaming
					? "Loading write details..."
					: "No file path or content provided"}
			</div>
		);
	}

	// Validate output if present
	const outputValidation = output ? validateWriteOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as WriteToolOutput | null;

	// Extract file name from path
	const fileName =
		validInput.file_path.split("/").pop() || validInput.file_path;
	const language = detectLanguage(validInput.file_path);

	// Create preview (first 10 lines)
	const lines = validInput.content.split("\n");
	const isTruncated = lines.length > 10;
	const preview = lines.slice(0, 10).join("\n");
	const previewWithEllipsis = isTruncated ? `${preview}\n...` : preview;

	return (
		<div className="space-y-4 p-4">
			{/* File Info Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FileEdit className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Writing File
					</h4>
				</div>

				<div className="flex flex-wrap items-center gap-2 text-sm">
					<code className="rounded bg-muted px-2 py-1 font-mono text-foreground">
						{fileName}
					</code>
					{validOutput?.bytes_written !== undefined && (
						<span className="text-muted-foreground text-xs">
							{validOutput?.bytes_written} bytes
						</span>
					)}
				</div>

				<div className="font-mono text-muted-foreground text-xs">
					{shortenPath(validInput.file_path)}
				</div>
			</div>

			{/* Content Preview Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FileEdit className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Content Preview
					</h4>
					{isTruncated && (
						<span className="text-muted-foreground text-xs">
							{lines.length} lines (showing first 10)
						</span>
					)}
				</div>

				<Suspense
					fallback={
						<div className="h-32 animate-pulse rounded-md bg-muted/50" />
					}
				>
					<CodeBlock
						code={previewWithEllipsis}
						// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
						language={language as any}
						showLineNumbers
					/>
				</Suspense>
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
						{validOutput?.success !== undefined && (
							<span
								className={cn(
									"rounded px-2 py-0.5 text-xs",
									validOutput?.success
										? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
										: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
								)}
							>
								{validOutput?.success ? "Success" : "Failed"}
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
