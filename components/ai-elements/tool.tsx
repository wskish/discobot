import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	CircleIcon,
	ClockIcon,
	CodeIcon,
	WrenchIcon,
	XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, lazy, Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// Lazy-load CodeBlock to reduce initial bundle size (Shiki is heavy)
const CodeBlock = lazy(() =>
	import("./code-block").then((mod) => ({ default: mod.CodeBlock })),
);

function CodeBlockWithSuspense(props: ComponentProps<typeof CodeBlock>) {
	return (
		<Suspense
			fallback={<div className="animate-pulse bg-muted/50 rounded-md h-24" />}
		>
			<CodeBlock {...props} />
		</Suspense>
	);
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
	/** Whether to show the border around the tool */
	showBorder?: boolean;
};

export const Tool = ({ className, showBorder = true, ...props }: ToolProps) => (
	<Collapsible
		className={cn(
			"group not-prose mb-4 w-full rounded-md",
			showBorder && "border",
			className,
		)}
		{...props}
	/>
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
	title?: string;
	className?: string;
	/** Whether to show the wrench icon */
	showIcon?: boolean;
	/** Whether raw view is enabled (for optimized tools) */
	isRaw?: boolean;
	/** Callback to toggle raw view (for optimized tools) */
	onToggleRaw?: () => void;
} & (
	| { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
	| {
			type: DynamicToolUIPart["type"];
			state: DynamicToolUIPart["state"];
			toolName: string;
	  }
);

export const getStatusBadge = (status: ToolPart["state"]) => {
	const labels: Record<ToolPart["state"], string> = {
		"input-streaming": "Pending",
		"input-available": "Running",
		"approval-requested": "Awaiting Approval",
		"approval-responded": "Responded",
		"output-available": "Completed",
		"output-error": "Error",
		"output-denied": "Denied",
	};

	const icons: Record<ToolPart["state"], ReactNode> = {
		"input-streaming": <CircleIcon className="size-4" />,
		"input-available": <ClockIcon className="size-4 animate-pulse" />,
		"approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
		"approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
		"output-available": <CheckCircleIcon className="size-4 text-green-600" />,
		"output-error": <XCircleIcon className="size-4 text-red-600" />,
		"output-denied": <XCircleIcon className="size-4 text-orange-600" />,
	};

	return (
		<Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
			{icons[status]}
			{labels[status]}
		</Badge>
	);
};

export const ToolHeader = ({
	className,
	title,
	type,
	state,
	toolName,
	showIcon = true,
	isRaw,
	onToggleRaw,
	...props
}: ToolHeaderProps) => {
	const derivedName =
		type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

	// Parse title to extract verb badge (e.g., "RUN: ls -la" -> verb="RUN", rest="ls -la")
	const displayText = title ?? derivedName;
	const colonIndex = displayText.indexOf(": ");
	const hasVerb = colonIndex !== -1;
	const verb = hasVerb ? displayText.slice(0, colonIndex) : null;
	const rest = hasVerb ? displayText.slice(colonIndex + 2) : displayText;

	return (
		<CollapsibleTrigger
			className={cn(
				"flex w-full items-center justify-between gap-4",
				showIcon ? "p-3" : "px-3 py-1.5",
				className,
			)}
			{...props}
		>
			<div className="flex items-center gap-2">
				{showIcon && <WrenchIcon className="size-4 text-muted-foreground" />}
				{verb && (
					<Badge
						variant="secondary"
						className="rounded-full bg-primary/10 px-2 py-0.5 font-bold text-primary text-xs"
					>
						{verb}
					</Badge>
				)}
				<span className="font-medium text-sm">{rest}</span>
				{state !== "output-available" && getStatusBadge(state)}
			</div>
			<div className="flex items-center gap-2">
				{onToggleRaw && (
					<>
						{/* biome-ignore lint/a11y/useSemanticElements: Cannot use button element as it would be nested inside CollapsibleTrigger button */}
						<span
							role="button"
							tabIndex={0}
							className="inline-flex size-7 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground group-data-[state=open]:opacity-100"
							onClick={(e) => {
								e.stopPropagation();
								onToggleRaw();
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									e.stopPropagation();
									onToggleRaw();
								}
							}}
							title={isRaw ? "Show optimized view" : "Show raw view"}
						>
							<CodeIcon className="size-4" />
						</span>
					</>
				)}
				<ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
			</div>
		</CollapsibleTrigger>
	);
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
	<CollapsibleContent
		className={cn(
			"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
			className,
		)}
		{...props}
	/>
);

export type ToolInputProps = ComponentProps<"div"> & {
	input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
	<div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
		<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
			Parameters
		</h4>
		<div className="rounded-md bg-muted/50">
			<CodeBlockWithSuspense
				code={JSON.stringify(input, null, 2) ?? ""}
				language="json"
			/>
		</div>
	</div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
	output: ToolPart["output"];
	errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
	className,
	output,
	errorText,
	...props
}: ToolOutputProps) => {
	if (!(output || errorText)) {
		return null;
	}

	let Output = <div>{output as ReactNode}</div>;

	if (typeof output === "object" && !isValidElement(output)) {
		Output = (
			<CodeBlockWithSuspense
				code={JSON.stringify(output, null, 2)}
				language="json"
			/>
		);
	} else if (typeof output === "string") {
		Output = <CodeBlockWithSuspense code={output} language="json" />;
	}

	return (
		<div className={cn("space-y-2 p-4", className)} {...props}>
			<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{errorText ? "Error" : "Result"}
			</h4>
			<div
				className={cn(
					"overflow-x-auto rounded-md text-xs [&_table]:w-full",
					errorText
						? "bg-destructive/10 text-destructive"
						: "bg-muted/50 text-foreground",
				)}
			>
				{errorText && <div>{errorText}</div>}
				{Output}
			</div>
		</div>
	);
};
