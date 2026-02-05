import { FileText, Search } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type GrepToolInput,
	type GrepToolOutput,
	validateGrepInput,
	validateGrepOutput,
} from "../tool-schemas/grep-schema";
import { shortenPath } from "./index";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * GrepToolRenderer - Optimized renderer for Grep tool
 *
 * Displays search operations with:
 * - Search pattern in monospace
 * - Filter badges (path, glob, type)
 * - Match count indicator
 * - File paths with line numbers (for structured matches)
 * - Syntax-highlighted content (for content mode)
 */
export default function GrepToolRenderer({
	input,
	output,
	errorText,
	state,
}: ToolRendererProps<GrepToolInput, GrepToolOutput>) {
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
	const inputValidation = validateGrepInput(input);

	if (!inputValidation.success) {
		// During streaming, validation may fail due to incomplete input - don't log spam
		if (!isStreaming) {
			console.warn(
				`Grep tool input validation failed: ${inputValidation.error}`,
			);
		}

		// Show loading state during streaming, fallback to generic display otherwise
		if (isStreaming) {
			return (
				<div className="p-4 text-muted-foreground text-sm">
					Loading search details...
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

	// Validate output if present
	const outputValidation = output ? validateGrepOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as GrepToolOutput | null;

	// Determine result count
	const resultCount = validOutput?.count
		? validOutput?.count
		: validOutput?.files
			? validOutput?.files.length
			: validOutput?.matches
				? validOutput?.matches.length
				: 0;

	return (
		<div className="space-y-4 p-4">
			{/* Search Pattern Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Search className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Search Pattern
					</h4>
				</div>

				<code className="block rounded bg-muted px-3 py-2 font-mono text-foreground text-sm">
					{validInput.pattern}
				</code>

				{/* Filters */}
				{(validInput.path ||
					validInput.glob ||
					validInput.type ||
					validInput["-i"] ||
					validInput.multiline) && (
					<div className="flex flex-wrap gap-2">
						{validInput.path && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								path: {shortenPath(validInput.path)}
							</span>
						)}
						{validInput.glob && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								glob: {validInput.glob}
							</span>
						)}
						{validInput.type && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								type: {validInput.type}
							</span>
						)}
						{validInput["-i"] && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								case-insensitive
							</span>
						)}
						{validInput.multiline && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								multiline
							</span>
						)}
					</div>
				)}
			</div>

			{/* Results Section */}
			{validOutput && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<FileText className="size-4 text-muted-foreground" />
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Results
						</h4>
						{resultCount > 0 && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								{resultCount} {resultCount === 1 ? "match" : "matches"}
							</span>
						)}
					</div>

					{/* Content mode - show syntax highlighted output */}
					{validOutput?.content && (
						<Suspense
							fallback={
								<div className="h-32 animate-pulse rounded-md bg-muted/50" />
							}
						>
							<CodeBlock
								code={validOutput?.content}
								// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
								language={"text" as any}
								showLineNumbers
							/>
						</Suspense>
					)}

					{/* Files mode - show file list */}
					{validOutput?.files && validOutput?.files.length > 0 && (
						<div className="space-y-1 rounded-md border bg-muted/30 p-3">
							{validOutput?.files.map((file: string, _idx: number) => (
								<div key={file} className="font-mono text-foreground text-xs">
									{file}
								</div>
							))}
						</div>
					)}

					{/* Structured matches mode */}
					{validOutput?.matches && validOutput?.matches.length > 0 && (
						<div className="space-y-2">
							{validOutput?.matches.map(
								(
									match: { file: string; line: number; content: string },
									_idx: number,
								) => (
									<div
										key={`${match.file}-${match.line}`}
										className="rounded-md border bg-muted/30 p-2"
									>
										<div className="mb-1 flex items-center gap-2 text-xs">
											<span className="font-mono text-foreground">
												{match.file}
											</span>
											<span className="text-muted-foreground">
												line {match.line}
											</span>
										</div>
										<code className="block font-mono text-foreground text-xs">
											{match.content}
										</code>
									</div>
								),
							)}
						</div>
					)}

					{/* Count mode - just show the count */}
					{validOutput?.count !== undefined &&
						!validOutput?.content &&
						!validOutput?.files &&
						!validOutput?.matches && (
							<div className="rounded-md bg-muted/50 p-3 text-center text-foreground">
								{validOutput?.count}{" "}
								{validOutput?.count === 1 ? "match" : "matches"} found
							</div>
						)}
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
