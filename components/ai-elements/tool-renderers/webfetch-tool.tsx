import { ExternalLink, Globe } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	validateWebFetchInput,
	validateWebFetchOutput,
	type WebFetchToolInput,
	type WebFetchToolOutput,
} from "../tool-schemas/webfetch-schema";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * WebFetchToolRenderer - Optimized renderer for WebFetch tool
 *
 * Displays web fetch operations with:
 * - URL and hostname display
 * - Prompt/query shown
 * - Fetched content preview
 */
export default function WebFetchToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<WebFetchToolInput, WebFetchToolOutput>) {
	// Validate input
	const inputValidation = validateWebFetchInput(input);

	if (!inputValidation.success) {
		console.warn(
			`WebFetch tool input validation failed: ${inputValidation.error}`,
		);
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
	const outputValidation = output ? validateWebFetchOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as WebFetchToolOutput | null;

	// Extract hostname from URL
	let hostname = validInput.url;
	try {
		hostname = new URL(validInput.url).hostname;
	} catch {
		// Invalid URL, use as-is
	}

	return (
		<div className="space-y-4 p-4">
			{/* URL Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Globe className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Fetching from
					</h4>
				</div>

				<div className="flex items-center gap-2">
					<a
						href={validInput.url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 text-foreground text-sm hover:underline"
					>
						<span className="font-mono">{hostname}</span>
						<ExternalLink className="size-3" />
					</a>
				</div>

				<div className="font-mono text-muted-foreground text-xs">
					{validInput.url}
				</div>
			</div>

			{/* Prompt Section */}
			<div className="space-y-2">
				<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Query
				</h4>
				<p className="text-foreground text-sm">{validInput.prompt}</p>
			</div>

			{/* Content Section */}
			{validOutput?.content && (
				<div className="space-y-2">
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Result
					</h4>

					<Suspense
						fallback={
							<div className="h-32 animate-pulse rounded-md bg-muted/50" />
						}
					>
						<CodeBlock code={validOutput?.content} language="markdown" />
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
