import {
	parseWorkspacePath,
	WorkspaceIcon,
} from "@/components/ide/workspace-path";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Workspace } from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface WorkspaceDisplayProps {
	workspace: Workspace;
	/** Size of the icon in pixels */
	iconSize?: number;
	/** Additional classes for the icon */
	iconClassName?: string;
	/** Additional classes for the text */
	textClassName?: string;
	/** Additional classes for the container */
	className?: string;
	/** Whether to show tooltip with full path (defaults to true when displayName is used or path is shortened) */
	showTooltip?: boolean;
}

/**
 * Displays a workspace icon and name consistently across the app.
 * Respects the workspace's displayName property if set, otherwise shows the parsed path.
 * Shows a tooltip with the full path when the displayName is used or path is shortened.
 */
export function WorkspaceDisplay({
	workspace,
	iconSize: _iconSize = 16,
	iconClassName,
	textClassName,
	className,
	showTooltip,
}: WorkspaceDisplayProps) {
	const { displayPath, fullPath, workspaceType, wasShortened } =
		parseWorkspacePath(workspace.path, workspace.sourceType);

	// Use displayName if set, otherwise use parsed path
	const displayText = workspace.displayName || displayPath;

	// Show tooltip if explicitly requested, or if displayName is used or path was shortened
	const shouldShowTooltip =
		showTooltip ?? (!!workspace.displayName || wasShortened);

	const content = (
		<div className={cn("flex items-center gap-1.5 min-w-0", className)}>
			<WorkspaceIcon
				workspaceType={workspaceType}
				className={cn("shrink-0", iconClassName)}
			/>
			<span className={cn("truncate", textClassName)}>{displayText}</span>
		</div>
	);

	if (shouldShowTooltip) {
		// Build tooltip text
		const tooltipText = workspace.displayName
			? `${workspace.displayName} (${fullPath})`
			: fullPath;

		return (
			<Tooltip>
				<TooltipTrigger asChild>{content}</TooltipTrigger>
				<TooltipContent side="bottom" className="font-mono text-xs">
					{tooltipText}
				</TooltipContent>
			</Tooltip>
		);
	}

	return content;
}
