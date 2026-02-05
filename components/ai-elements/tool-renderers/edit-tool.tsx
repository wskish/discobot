import { CheckCircle, FileEdit, XCircle } from "lucide-react";
import { lazy, Suspense } from "react";
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

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * EditToolRenderer - Optimized renderer for Edit tool
 *
 * Displays file edit operations with:
 * - File path
 * - Before/after snippets
 * - Replacement count
 * - Success indicator
 */
export default function EditToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<EditToolInput, EditToolOutput>) {
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

	// Validate output if present
	const outputValidation = output ? validateEditOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as EditToolOutput | null;

	// Extract file name from path
	const fileName =
		validInput.file_path.split("/").pop() || validInput.file_path;

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
					{validInput.file_path}
				</div>
			</div>

			{/* Changes Section */}
			<div className="space-y-3">
				{/* Old String */}
				<div className="space-y-1">
					<h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Replace
					</h5>
					<Suspense
						fallback={
							<div className="h-20 animate-pulse rounded-md bg-muted/50" />
						}
					>
						<CodeBlock
							code={validInput.old_string}
							// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
							language={"text" as any}
						/>
					</Suspense>
				</div>

				{/* New String */}
				<div className="space-y-1">
					<h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						With
					</h5>
					<Suspense
						fallback={
							<div className="h-20 animate-pulse rounded-md bg-muted/50" />
						}
					>
						<CodeBlock
							code={validInput.new_string}
							// biome-ignore lint/suspicious/noExplicitAny: CodeBlock requires BundledLanguage type
							language={"text" as any}
						/>
					</Suspense>
				</div>
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
