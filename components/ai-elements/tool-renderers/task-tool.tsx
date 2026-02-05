import { Bot, FileOutput, Play } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type TaskToolInput,
	type TaskToolOutput,
	validateTaskInput,
	validateTaskOutput,
} from "../tool-schemas/task-schema";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * TaskToolRenderer - Optimized renderer for Task tool
 *
 * Displays sub-agent task operations with:
 * - Agent type and description
 * - Task prompt
 * - Agent ID
 * - Background mode indicator
 * - Output file path (for background tasks)
 */
export default function TaskToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<TaskToolInput, TaskToolOutput>) {
	// Validate input
	const inputValidation = validateTaskInput(input);

	if (!inputValidation.success) {
		console.warn(`Task tool input validation failed: ${inputValidation.error}`);
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
	const outputValidation = output ? validateTaskOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as TaskToolOutput | null;

	return (
		<div className="space-y-4 p-4">
			{/* Agent Info Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Bot className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Sub-Agent
					</h4>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<code className="rounded bg-muted px-2 py-1 font-mono text-foreground text-sm">
						{validInput.subagent_type}
					</code>
					{validInput.run_in_background && (
						<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
							Background
						</span>
					)}
					{validInput.model && (
						<span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
							{validInput.model}
						</span>
					)}
					{validInput.max_turns && (
						<span className="text-muted-foreground text-xs">
							max {validInput.max_turns} turns
						</span>
					)}
				</div>

				<p className="text-foreground text-sm">{validInput.description}</p>
			</div>

			{/* Task Prompt Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Play className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Task
					</h4>
				</div>

				<div className="rounded-md border bg-muted/30 p-3">
					<p className="text-foreground text-sm">{validInput.prompt}</p>
				</div>
			</div>

			{/* Output Section */}
			{validOutput && (
				<div className="space-y-2">
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Result
					</h4>

					{validOutput?.agentId && (
						<div className="flex items-center gap-2 text-xs">
							<span className="text-muted-foreground">Agent ID:</span>
							<code className="font-mono text-foreground">
								{validOutput?.agentId}
							</code>
						</div>
					)}

					{validOutput?.output_file && (
						<div className="flex items-center gap-2 rounded-md bg-muted/50 p-2">
							<FileOutput className="size-4 text-muted-foreground" />
							<code className="font-mono text-foreground text-xs">
								{validOutput?.output_file}
							</code>
						</div>
					)}

					{validOutput?.result && (
						<Suspense
							fallback={
								<div className="h-32 animate-pulse rounded-md bg-muted/50" />
							}
						>
							<CodeBlock code={validOutput?.result} language="markdown" />
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
