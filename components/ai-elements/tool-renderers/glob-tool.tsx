import { FileText, FolderTree } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type GlobToolInput,
	type GlobToolOutput,
	validateGlobInput,
	validateGlobOutput,
} from "../tool-schemas/glob-schema";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * GlobToolRenderer - Optimized renderer for Glob tool
 *
 * Displays file pattern matching with:
 * - Pattern display in monospace
 * - File count badge
 * - List of matched files (limited to 20 with "... and N more")
 * - Search path indicator
 */
export default function GlobToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<GlobToolInput, GlobToolOutput>) {
	// Validate input
	const inputValidation = validateGlobInput(input);

	if (!inputValidation.success) {
		console.warn(`Glob tool input validation failed: ${inputValidation.error}`);
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
	const outputValidation = output ? validateGlobOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as GlobToolOutput | null;

	// Get files list
	const files = validOutput?.files || [];
	const displayLimit = 20;
	const displayFiles = files.slice(0, displayLimit);
	const remainingCount = files.length - displayLimit;

	return (
		<div className="space-y-4 p-4">
			{/* Pattern Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<FolderTree className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						File Pattern
					</h4>
				</div>

				<code className="block rounded bg-muted px-3 py-2 font-mono text-foreground text-sm">
					{validInput.pattern}
				</code>

				{validInput.path && (
					<div className="text-muted-foreground text-xs">
						in: <span className="font-mono">{validInput.path}</span>
					</div>
				)}
			</div>

			{/* Results Section */}
			{validOutput && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<FileText className="size-4 text-muted-foreground" />
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Matched Files
						</h4>
						{files.length > 0 && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								{files.length} {files.length === 1 ? "file" : "files"}
							</span>
						)}
					</div>

					{/* Files list */}
					{files.length > 0 ? (
						<div className="space-y-1 rounded-md border bg-muted/30 p-3">
							{displayFiles.map((file: string, _idx: number) => (
								<div key={file} className="font-mono text-foreground text-xs">
									{file}
								</div>
							))}
							{remainingCount > 0 && (
								<div className="pt-2 text-muted-foreground text-xs">
									... and {remainingCount} more{" "}
									{remainingCount === 1 ? "file" : "files"}
								</div>
							)}
						</div>
					) : (
						<div className="rounded-md bg-muted/50 p-3 text-center text-muted-foreground text-sm">
							No files matched the pattern
						</div>
					)}

					{/* String content fallback */}
					{validOutput?.content && !validOutput?.files && (
						<Suspense
							fallback={
								<div className="h-32 animate-pulse rounded-md bg-muted/50" />
							}
						>
							<CodeBlock
								code={validOutput?.content}
								// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
								language={"text" as any}
							/>
						</Suspense>
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
