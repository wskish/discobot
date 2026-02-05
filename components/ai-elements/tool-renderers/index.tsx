import type { DynamicToolUIPart } from "ai";
import { type ComponentType, lazy, Suspense } from "react";
import {
	ToolInput as DefaultToolInput,
	ToolOutput as DefaultToolOutput,
} from "../tool";
import type { ToolRendererProps } from "../tool-schemas";

// Lazy load tool renderers to avoid bloating initial bundle
// Each renderer is code-split into its own chunk
const BashTool = lazy(() => import("./bash-tool"));
const ReadTool = lazy(() => import("./read-tool"));
const WriteTool = lazy(() => import("./write-tool"));
const EditTool = lazy(() => import("./edit-tool"));
const GrepTool = lazy(() => import("./grep-tool"));
const GlobTool = lazy(() => import("./glob-tool"));
const WebSearchTool = lazy(() => import("./websearch-tool"));
const WebFetchTool = lazy(() => import("./webfetch-tool"));
const TodoWriteTool = lazy(() => import("./todowrite-tool"));
const TaskTool = lazy(() => import("./task-tool"));
const SkillTool = lazy(() => import("./skill-tool"));

/**
 * Replace /home/discobot with ~ in file paths for cleaner display
 */
export function shortenPath(path: string): string {
	return path.replace(/^\/home\/discobot/, "~");
}

/**
 * Tool renderer registry
 *
 * Maps tool names (as they appear in the API) to their specialized
 * renderer components. Add new tool renderers here.
 */
const TOOL_RENDERERS: Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: Required for generic tool renderer compatibility
	ComponentType<ToolRendererProps<any, any>>
> = {
	Bash: BashTool,
	Read: ReadTool,
	Write: WriteTool,
	Edit: EditTool,
	Grep: GrepTool,
	Glob: GlobTool,
	WebSearch: WebSearchTool,
	WebFetch: WebFetchTool,
	TodoWrite: TodoWriteTool,
	Task: TaskTool,
	Skill: SkillTool,
};

/**
 * Checks if a tool has an optimized renderer
 */
export function hasOptimizedRenderer(toolName: string): boolean {
	return toolName in TOOL_RENDERERS;
}

/**
 * Loading fallback shown while tool renderer lazy-loads
 */
function ToolRendererFallback() {
	return (
		<div className="animate-pulse rounded-md bg-muted/50 p-4">
			<div className="mb-2 h-4 w-3/4 rounded bg-muted" />
			<div className="h-4 w-1/2 rounded bg-muted" />
		</div>
	);
}

interface OptimizedToolRendererProps {
	/** The tool part to render */
	toolPart: DynamicToolUIPart;
	/** Force raw JSON display instead of optimized renderer */
	forceRaw?: boolean;
}

/**
 * Generates a contextual title for a tool based on its input
 *
 * Returns a human-readable description that includes key information
 * from the tool's input (e.g., command, file path, search query).
 */
export function getToolTitle(toolPart: DynamicToolUIPart): string | undefined {
	const { toolName, input } = toolPart;

	// Return custom title if already provided
	if (toolPart.title) {
		return toolPart.title;
	}

	// Guard against undefined input (can happen during streaming or malformed calls)
	if (!input) {
		return undefined;
	}

	// Type-safe input access
	const safeInput = input as Record<string, unknown>;

	switch (toolName) {
		case "Bash": {
			const command = safeInput.command;
			if (typeof command === "string") {
				// Truncate long commands
				const truncated =
					command.length > 60 ? `${command.slice(0, 60)}...` : command;
				return `Run: ${truncated}`;
			}
			break;
		}
		case "Read": {
			const filePath = safeInput.file_path;
			if (typeof filePath === "string") {
				// Show just the filename
				const fileName = filePath.split("/").pop() || filePath;
				return `Read: ${fileName}`;
			}
			break;
		}
		case "Write": {
			const filePath = safeInput.file_path;
			if (typeof filePath === "string") {
				const fileName = filePath.split("/").pop() || filePath;
				return `Write: ${fileName}`;
			}
			break;
		}
		case "Edit": {
			const filePath = safeInput.file_path;
			if (typeof filePath === "string") {
				const fileName = filePath.split("/").pop() || filePath;
				return `Edit: ${fileName}`;
			}
			break;
		}
		case "Grep": {
			const pattern = safeInput.pattern;
			if (typeof pattern === "string") {
				const truncated =
					pattern.length > 50 ? `${pattern.slice(0, 50)}...` : pattern;
				return `Search: ${truncated}`;
			}
			break;
		}
		case "WebSearch": {
			const query = safeInput.query;
			if (typeof query === "string") {
				const truncated =
					query.length > 50 ? `${query.slice(0, 50)}...` : query;
				return `Search: ${truncated}`;
			}
			break;
		}
		case "WebFetch": {
			const url = safeInput.url;
			if (typeof url === "string") {
				try {
					const hostname = new URL(url).hostname;
					return `Fetch: ${hostname}`;
				} catch {
					const truncated = url.length > 50 ? `${url.slice(0, 50)}...` : url;
					return `Fetch: ${truncated}`;
				}
			}
			break;
		}
		case "TodoWrite": {
			const todos = safeInput.todos;
			if (Array.isArray(todos)) {
				return `Track: ${todos.length} ${todos.length === 1 ? "task" : "tasks"}`;
			}
			break;
		}
		case "Glob": {
			const pattern = safeInput.pattern;
			if (typeof pattern === "string") {
				const truncated =
					pattern.length > 50 ? `${pattern.slice(0, 50)}...` : pattern;
				return `Find: ${truncated}`;
			}
			break;
		}
		case "Task": {
			const description = safeInput.description;
			if (typeof description === "string") {
				const truncated =
					description.length > 50
						? `${description.slice(0, 50)}...`
						: description;
				return `Launch: ${truncated}`;
			}
			break;
		}
		case "Skill": {
			const skill = safeInput.skill;
			if (typeof skill === "string") {
				return `Run: ${skill}`;
			}
			break;
		}
	}

	// Fallback to tool name
	return undefined;
}

/**
 * OptimizedToolRenderer - Routes tool rendering to specialized components
 *
 * This component:
 * 1. Looks up the specialized renderer by tool name
 * 2. Lazy-loads and renders it with Suspense boundary
 * 3. Falls back to generic JSON rendering if no renderer exists
 *
 * Each tool renderer performs its own schema validation and can
 * fall back to generic rendering if validation fails.
 */
export function OptimizedToolRenderer({
	toolPart,
	forceRaw = false,
}: OptimizedToolRendererProps) {
	const { toolName, input, output, errorText, state, toolCallId } = toolPart;

	// If forceRaw is true, skip optimized rendering
	if (forceRaw) {
		return (
			<>
				<DefaultToolInput input={input} />
				<DefaultToolOutput output={output} errorText={errorText} />
			</>
		);
	}

	// Look up specialized renderer
	const ToolRenderer = TOOL_RENDERERS[toolName];

	if (ToolRenderer) {
		return (
			<Suspense fallback={<ToolRendererFallback />}>
				<ToolRenderer
					toolCallId={toolCallId}
					input={input}
					output={output}
					errorText={errorText}
					state={state}
				/>
			</Suspense>
		);
	}

	// Fallback to generic JSON rendering for unknown tools
	return (
		<>
			<DefaultToolInput input={input} />
			<DefaultToolOutput output={output} errorText={errorText} />
		</>
	);
}
