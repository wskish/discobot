import { CheckCircle, Clock, Terminal, XCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type BashToolInput,
	type BashToolOutput,
	validateBashInput,
	validateBashOutput,
} from "../tool-schemas/bash-schema";

// Lazy load CodeBlock to avoid bloating bundle
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * BashToolRenderer - Optimized renderer for Bash tool
 *
 * Displays shell commands in a terminal-style UI with:
 * - $ prompt indicator
 * - Command description
 * - Metadata badges (timeout, background mode)
 * - Exit code indicator
 * - Separated stdout/stderr streams
 * - Syntax highlighting for output
 */
export default function BashToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<BashToolInput, BashToolOutput>) {
	// Validate input
	const inputValidation = validateBashInput(input);

	if (!inputValidation.success) {
		console.warn(`Bash tool input validation failed: ${inputValidation.error}`);
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
	const outputValidation = output ? validateBashOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as BashToolOutput | null;

	return (
		<div className="space-y-4 p-4">
			{/* Command Input Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Terminal className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Command
					</h4>
					{validInput.run_in_background && (
						<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
							Background
						</span>
					)}
					{validInput.timeout !== undefined && (
						<span className="flex items-center gap-1 text-muted-foreground text-xs">
							<Clock className="size-3" />
							{validInput.timeout}ms
						</span>
					)}
				</div>

				{validInput.description && (
					<p className="italic text-muted-foreground text-sm">
						{validInput.description}
					</p>
				)}

				<div className="overflow-hidden rounded-md border bg-muted/50 font-mono text-sm">
					<div className="border-border border-b bg-muted/30 px-3 py-2">
						<span className="text-muted-foreground text-xs">$</span>
					</div>
					<div className="px-3 py-2">
						<code className="text-foreground">{validInput.command}</code>
					</div>
				</div>
			</div>

			{/* Output Section */}
			{(validOutput || errorText) && (
				<div className="space-y-2">
					<div className="flex items-center gap-2">
						{errorText ? (
							<XCircle className="size-4 text-destructive" />
						) : validOutput?.exitCode === 0 ||
							validOutput?.exitCode === undefined ? (
							<CheckCircle className="size-4 text-green-600 dark:text-green-400" />
						) : (
							<XCircle className="size-4 text-yellow-600 dark:text-yellow-400" />
						)}
						<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							{errorText ? "Error" : "Output"}
						</h4>
						{validOutput?.exitCode !== undefined && (
							<span
								className={cn(
									"rounded px-2 py-0.5 font-mono text-xs",
									validOutput?.exitCode === 0
										? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400"
										: "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-400",
								)}
							>
								exit {validOutput?.exitCode}
							</span>
						)}
					</div>

					{errorText ? (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
							{errorText}
						</div>
					) : (
						<>
							{/* Main output (stdout or combined) */}
							{(validOutput?.output || validOutput?.stdout) && (
								<Suspense
									fallback={
										<div className="h-24 animate-pulse rounded-md bg-muted/50" />
									}
								>
									<CodeBlock
										code={validOutput?.output || validOutput?.stdout || ""}
										language="bash"
									/>
								</Suspense>
							)}

							{/* Stderr (if separate) */}
							{validOutput?.stderr && (
								<div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900 dark:bg-yellow-950/20">
									<h5 className="mb-2 font-medium text-yellow-800 text-xs dark:text-yellow-400">
										STDERR
									</h5>
									<pre className="whitespace-pre-wrap text-yellow-700 text-xs dark:text-yellow-500">
										{validOutput?.stderr}
									</pre>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}
