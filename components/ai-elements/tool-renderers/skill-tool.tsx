import { Sparkles } from "lucide-react";
import { lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";
import {
	type SkillToolInput,
	type SkillToolOutput,
	validateSkillInput,
	validateSkillOutput,
} from "../tool-schemas/skill-schema";

// Lazy load CodeBlock
const CodeBlock = lazy(() =>
	import("../code-block").then((mod) => ({ default: mod.CodeBlock })),
);

/**
 * SkillToolRenderer - Optimized renderer for Skill tool
 *
 * Displays skill execution with:
 * - Skill name
 * - Arguments passed
 * - Execution result
 */
export default function SkillToolRenderer({
	input,
	output,
	errorText,
}: ToolRendererProps<SkillToolInput, SkillToolOutput>) {
	// Validate input
	const inputValidation = validateSkillInput(input);

	if (!inputValidation.success) {
		console.warn(
			`Skill tool input validation failed: ${inputValidation.error}`,
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
	const outputValidation = output ? validateSkillOutput(output) : null;
	const validOutput = (
		outputValidation?.success ? outputValidation.data : null
	) as SkillToolOutput | null;

	return (
		<div className="space-y-4 p-4">
			{/* Skill Info Section */}
			<div className="space-y-2">
				<div className="flex items-center gap-2">
					<Sparkles className="size-4 text-muted-foreground" />
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Skill
					</h4>
				</div>

				<code className="block rounded bg-muted px-3 py-2 font-mono text-foreground text-sm">
					/{validInput.skill}
				</code>

				{validInput.args && (
					<div className="space-y-1">
						<h5 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Arguments
						</h5>
						<code className="block rounded bg-muted/50 px-3 py-2 font-mono text-foreground text-xs">
							{validInput.args}
						</code>
					</div>
				)}
			</div>

			{/* Output Section */}
			{validOutput?.result && (
				<div className="space-y-2">
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
						Result
					</h4>

					<Suspense
						fallback={
							<div className="h-32 animate-pulse rounded-md bg-muted/50" />
						}
					>
						<CodeBlock code={validOutput?.result} language="markdown" />
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
