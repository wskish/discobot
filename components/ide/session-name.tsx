import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Session } from "@/lib/api-types";
import { getSessionStatusIndicator } from "@/lib/session-utils";
import { cn } from "@/lib/utils";

/**
 * Gets the display name for a session.
 * Returns displayName if set, otherwise falls back to the original name.
 */
export function getSessionDisplayName(session: Session): string {
	return session.displayName || session.name;
}

interface SessionNameProps {
	session: Session;
	/** Show status indicator icon */
	showIcon?: boolean;
	/** Additional CSS class for the icon */
	iconClassName?: string;
	/** Additional CSS class for the container */
	className?: string;
	/** Additional CSS class for the text */
	textClassName?: string;
}

/**
 * Renders a session name with optional status indicator icon and tooltip.
 * Shows displayName if set, otherwise shows the original name.
 * When displayName is set, shows a tooltip with both displayName and original name.
 */
export function SessionName({
	session,
	showIcon = false,
	iconClassName = "h-4 w-4 shrink-0",
	className,
	textClassName,
}: SessionNameProps) {
	const displayName = getSessionDisplayName(session);
	const hasCustomName = !!session.displayName;

	const content = (
		<span className={cn("flex items-center gap-1.5 min-w-0", className)}>
			{showIcon && (
				<span className={cn("flex items-center justify-center", iconClassName)}>
					{getSessionStatusIndicator(session)}
				</span>
			)}
			<span className={cn("truncate", textClassName)}>{displayName}</span>
		</span>
	);

	// Show tooltip if there's a custom display name
	if (hasCustomName) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{content}</TooltipTrigger>
				<TooltipContent side="bottom" className="text-xs">
					<div className="font-medium">{session.displayName}</div>
					<div className="text-muted-foreground">{session.name}</div>
				</TooltipContent>
			</Tooltip>
		);
	}

	return content;
}
