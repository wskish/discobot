import { ExternalLink, Globe, Search } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	validateWebSearchInput,
	validateWebSearchOutput,
	type WebSearchToolInput,
	type WebSearchToolOutput,
} from "../tool-schemas/websearch-schema";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * WebSearchToolRenderer - Optimized renderer for WebSearch tool
 *
 * Displays web search operations with:
 * - Search query display
 * - Domain filters (allowed/blocked)
 * - Results as cards with titles, URLs, and snippets
 * - Favicon icons (if available)
 * - Clickable links
 */
export default function WebSearchToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<WebSearchToolInput, WebSearchToolOutput>) {
	// Validate input
	const inputValidation = validateWebSearchInput(input);

	if (!inputValidation.success) {
		console.warn(
			`WebSearch tool input validation failed: ${inputValidation.error}`,
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
	const outputValidation = output ? validateWebSearchOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as WebSearchToolOutput | null;

	return (
		<div className="space-y-4 p-4">
			{/* Search Query Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Globe className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Web Search
					</h4>
				</div>

				<div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
					<Search className="size-4 text-muted-foreground" />
					<span className="text-foreground text-sm">{validInput.query}</span>
				</div>

				{/* Domain Filters */}
				{(validInput.allowed_domains?.length ||
					validInput.blocked_domains?.length) && (
					<div className="space-y-1 text-xs">
						{validInput.allowed_domains &&
							validInput.allowed_domains.length > 0 && (
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground">
										Allowed domains:
									</span>
									<span className="text-foreground">
										{validInput.allowed_domains.join(", ")}
									</span>
								</div>
							)}
						{validInput.blocked_domains &&
							validInput.blocked_domains.length > 0 && (
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground">
										Blocked domains:
									</span>
									<span className="text-foreground">
										{validInput.blocked_domains.join(", ")}
									</span>
								</div>
							)}
					</div>
				)}
			</div>

			{/* Results Section */}
			{validOutput && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Search className="size-4 text-muted-foreground" />
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Results
						</h4>
						{validOutput?.results && validOutput?.results.length > 0 && (
							<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
								{validOutput?.results.length}{" "}
								{validOutput?.results.length === 1 ? "result" : "results"}
							</span>
						)}
					</div>

					{/* Structured results - render as cards */}
					{validOutput?.results && validOutput?.results.length > 0 && (
						<div className="space-y-2">
							{validOutput?.results.map(
								(
									result: {
										title: string;
										url: string;
										snippet?: string;
										favicon?: string;
									},
									_idx: number,
								) => (
									<a
										key={result.url}
										href={result.url}
										target="_blank"
										rel="noopener noreferrer"
										className="block rounded-md border bg-muted/30 p-3 transition-colors hover:bg-muted/50"
									>
										<div className="mb-1 flex items-start gap-2">
											{result.favicon && (
												<img
													src={result.favicon}
													alt=""
													className="mt-0.5 size-4 shrink-0"
												/>
											)}
											<div className="flex-1">
												<h5 className="font-medium text-foreground text-sm">
													{result.title}
												</h5>
												<div className="mt-1 flex items-center gap-1 text-muted-foreground text-xs">
													<span className="truncate">{result.url}</span>
													<ExternalLink className="size-3 shrink-0" />
												</div>
											</div>
										</div>
										{result.snippet && (
											<p className="text-muted-foreground text-xs">
												{result.snippet}
											</p>
										)}
									</a>
								),
							)}
						</div>
					)}

					{/* String content fallback */}
					{validOutput?.content && !validOutput?.results && (
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
