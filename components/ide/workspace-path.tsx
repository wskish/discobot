import { SiGithub } from "@icons-pack/react-simple-icons";
import { GitBranch, HardDrive } from "lucide-react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type WorkspaceType = "github" | "git" | "local";

function getWorkspaceType(path: string): WorkspaceType {
	if (path.includes("github.com") || path.startsWith("git@github.com")) {
		return "github";
	}
	if (
		path.startsWith("git@") ||
		path.startsWith("git://") ||
		(path.startsWith("https://") && path.includes(".git"))
	) {
		return "git";
	}
	return "local";
}

/**
 * Shortens a local path by replacing home directory prefixes with ~
 * Matches patterns like /home/username/... or /Users/username/...
 */
function shortenHomePath(path: string): {
	display: string;
	shortened: boolean;
} {
	const homeMatch = path.match(/^(\/home\/[^/]+|\/Users\/[^/]+)(\/.*)?$/);
	if (homeMatch) {
		const rest = homeMatch[2] || "";
		return { display: `~${rest}`, shortened: true };
	}
	return { display: path, shortened: false };
}

/**
 * Parses a workspace path and returns display information
 */
export function parseWorkspacePath(
	path: string,
	sourceType: "local" | "git" = "local",
): {
	displayPath: string;
	fullPath: string;
	isGitHub: boolean;
	workspaceType: WorkspaceType;
	wasShortened: boolean;
} {
	const workspaceType = getWorkspaceType(path);

	if (sourceType === "local") {
		const { display, shortened } = shortenHomePath(path);
		return {
			displayPath: display,
			fullPath: path,
			isGitHub: false,
			workspaceType: "local",
			wasShortened: shortened,
		};
	}

	// GitHub URLs
	const githubHttpMatch = path.match(/github\.com\/([^/]+\/[^/]+)/);
	const githubSshMatch = path.match(
		/git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
	);

	if (githubHttpMatch) {
		return {
			displayPath: githubHttpMatch[1],
			fullPath: path,
			isGitHub: true,
			workspaceType: "github",
			wasShortened: true,
		};
	}
	if (githubSshMatch) {
		return {
			displayPath: githubSshMatch[1],
			fullPath: path,
			isGitHub: true,
			workspaceType: "github",
			wasShortened: true,
		};
	}

	// Other git URLs - strip protocol and .git suffix
	const stripped = path
		.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
		.replace(/\.git$/, "");
	return {
		displayPath: stripped,
		fullPath: path,
		isGitHub: false,
		workspaceType,
		wasShortened: stripped !== path,
	};
}

interface WorkspaceIconProps {
	/** Workspace type - if provided, path is ignored */
	workspaceType?: WorkspaceType;
	/** Path to derive workspace type from - only used if workspaceType not provided */
	path?: string;
	className?: string;
}

export function WorkspaceIcon({
	workspaceType,
	path,
	className,
}: WorkspaceIconProps) {
	const type = workspaceType ?? (path ? getWorkspaceType(path) : "local");
	switch (type) {
		case "github":
			return <SiGithub className={className} />;
		case "git":
			return <GitBranch className={cn("text-orange-500", className)} />;
		case "local":
			return <HardDrive className={cn("text-blue-500", className)} />;
	}
}

/**
 * Simple helper to get display path - useful when you just need the shortened path
 */
export function getWorkspaceDisplayPath(
	path: string,
	sourceType: "local" | "git" = "local",
): string {
	return parseWorkspacePath(path, sourceType).displayPath;
}

/**
 * Gets a short name for a workspace (folder name or repo name).
 * Used for titles, labels, and other contexts where a brief identifier is needed.
 */
export function getWorkspaceShortName(
	path: string,
	sourceType: "local" | "git" = "local",
): string {
	if (sourceType === "local") {
		// For local paths, use the last segment
		const segments = path.split("/").filter(Boolean);
		return segments[segments.length - 1] || path;
	}

	// For git URLs, extract repo name
	const githubMatch = path.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
	if (githubMatch) {
		return githubMatch[1];
	}

	// Strip protocol and .git suffix for other git URLs, take last segment
	return (
		path
			.replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
			.replace(/\.git$/, "")
			.split("/")
			.pop() || path
	);
}

interface WorkspacePathProps {
	path: string;
	sourceType: "local" | "git";
	showIcon?: boolean;
	iconClassName?: string;
	className?: string;
}

/**
 * Renders a workspace path with optional icon and tooltip.
 * For local paths, replaces home directory prefix with ~
 * Shows full path in tooltip when shortened.
 */
export function WorkspacePath({
	path,
	sourceType,
	showIcon = false,
	iconClassName = "h-4 w-4 shrink-0",
	className,
}: WorkspacePathProps) {
	const { displayPath, fullPath, workspaceType, wasShortened } =
		parseWorkspacePath(path, sourceType);

	const content = (
		<span className={cn("flex items-center gap-1.5 min-w-0", className)}>
			{showIcon && (
				<WorkspaceIcon
					workspaceType={workspaceType}
					className={iconClassName}
				/>
			)}
			<span className="font-mono truncate">{displayPath}</span>
		</span>
	);

	if (wasShortened) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{content}</TooltipTrigger>
				<TooltipContent side="bottom" className="font-mono text-xs">
					{fullPath}
				</TooltipContent>
			</Tooltip>
		);
	}

	return content;
}
