import { Eye, FileText } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type ReadToolInput,
	type ReadToolOutput,
	validateReadInput,
	validateReadOutput,
} from "../tool-schemas/read-schema";
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
		cc: "cpp",
		cxx: "cpp",
		h: "c",
		hpp: "cpp",
		md: "markdown",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		sh: "bash",
		bash: "bash",
		css: "css",
		scss: "scss",
		sass: "sass",
		html: "html",
		xml: "xml",
		sql: "sql",
		rb: "ruby",
		php: "php",
		swift: "swift",
		kt: "kotlin",
		cs: "csharp",
		r: "r",
	};
	// biome-ignore lint/suspicious/noExplicitAny: Fallback to text when language detection fails
	return langMap[ext || ""] || ("text" as any);
}

/**
 * ReadToolRenderer - Optimized renderer for Read tool
 *
 * Displays file reading operations with:
 * - File path and metadata
 * - Syntax-highlighted content with line numbers
 * - Line count indicator
 * - Offset/limit/pages metadata
 */
export default function ReadToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<ReadToolInput, ReadToolOutput>) {
	// Validate input
	const inputValidation = validateReadInput(input);

	if (!inputValidation.success) {
		console.warn(`Read tool input validation failed: ${inputValidation.error}`);
		return (
			<>
				<DefaultToolInput input={input} />
				<DefaultToolOutput output={output} errorText={errorText} />
			</>
		);
	}

	// biome-ignore lint/style/noNonNullAssertion: Validated above
	const validInput = inputValidation.data!;

	// Validate output if present
	const outputValidation = output ? validateReadOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as ReadToolOutput | null;

	// Extract file name from path
	const fileName =
		validInput.file_path.split("/").pop() || validInput.file_path;
	const language = detectLanguage(validInput.file_path);

	// Get content (prefer content over lines)
	const content = validOutput?.content || validOutput?.lines?.join("\n") || "";

	return (
		<div className="space-y-4 p-4">
			{/* File Info Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FileText className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Reading File
					</h4>
				</div>

				<div className="flex flex-wrap items-center gap-2 text-sm">
					<code className="rounded bg-muted px-2 py-1 font-mono text-foreground">
						{fileName}
					</code>
					{validInput.offset !== undefined && (
						<span className="text-muted-foreground text-xs">
							offset: {validInput.offset}
						</span>
					)}
					{validInput.limit !== undefined && (
						<span className="text-muted-foreground text-xs">
							limit: {validInput.limit}
						</span>
					)}
					{validInput.pages && (
						<span className="text-muted-foreground text-xs">
							pages: {validInput.pages}
						</span>
					)}
				</div>

				<div className="font-mono text-muted-foreground text-xs">
					{shortenPath(validInput.file_path)}
				</div>
			</div>

			{/* File Content Section */}
			{content && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Eye className="size-4 text-muted-foreground" />
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Content
						</h4>
						<span className="text-muted-foreground text-xs">
							{content.split("\n").length} lines
						</span>
					</div>

					<Suspense
						fallback={
							<div className="h-48 animate-pulse rounded-md bg-muted/50" />
						}
					>
						<CodeBlock
							code={content}
							// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
							language={language as any}
							showLineNumbers
						/>
					</Suspense>
				</div>
			)}

			{/* Error Section */}
			{errorText && (
				<div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
					{errorText}
				</div>
			)}
		</div>
	);
}
