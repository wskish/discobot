import { ChevronDown } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { openUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * IDE configuration for launching remote SSH sessions.
 */
interface IDEConfig {
	id: string;
	name: string;
	/** URL handler template (use placeholders: {user}, {host}, {port}, {path}) */
	urlTemplate: string;
}

/**
 * Available IDEs for remote SSH sessions.
 *
 * Note: VS Code and Cursor don't support inline port numbers in their URL schemes.
 * They expect SSH config-based host definitions. For non-standard ports, users must
 * configure an SSH config entry with the appropriate port setting.
 */
const IDE_CONFIGS: IDEConfig[] = [
	{
		id: "vscode",
		name: "VS Code",
		urlTemplate: "vscode://vscode-remote/ssh-remote+{user}@{host}:{port}{path}",
	},
	{
		id: "cursor",
		name: "Cursor",
		urlTemplate: "cursor://vscode-remote/ssh-remote+{user}@{host}:{port}{path}",
	},
	{
		id: "jetbrains",
		name: "JetBrains",
		// JetBrains Gateway uses separate parameters for host, user, port, and path
		urlTemplate:
			"jetbrains-gateway://connect#projectPath={path}&host={host}&port={port}&user={user}&type=ssh",
	},
	{
		id: "zed",
		name: "Zed",
		// Zed supports full SSH connection string with optional port
		urlTemplate: "zed://ssh/{user}@{host}:{port}{path}",
	},
];

const PREFERENCE_KEY = "preferredIDE";
const SSH_PORT = 3333;
const WORKSPACE_PATH = "/home/discobot/workspace";

interface IDELauncherProps {
	sessionId: string;
	className?: string;
}

/**
 * Get the SSH host from the current location.
 * In browser mode, uses window.location.hostname.
 * Defaults to localhost.
 */
function getSSHHost(): string {
	if (typeof window === "undefined") return "localhost";
	// Use the current hostname, but for localhost variants use localhost
	const hostname = window.location.hostname;
	if (hostname === "127.0.0.1" || hostname === "::1") return "localhost";
	return hostname;
}

/**
 * Replace placeholders in a template string with actual values.
 */
function replacePlaceholders(
	template: string,
	user: string,
	host: string,
	port: number,
	path: string,
): string {
	return template
		.replace(/{user}/g, user)
		.replace(/{host}/g, host)
		.replace(/{port}/g, String(port))
		.replace(/{path}/g, path);
}

/**
 * IDE Launcher button with dropdown for selecting different IDEs.
 * Styled like GitHub's merge button with a split dropdown.
 */
export function IDELauncher({ sessionId, className }: IDELauncherProps) {
	// Use the preferences hook for IDE selection persistence
	const { getPreference, setPreference } = usePreferences();

	// Get selected IDE from preferences, default to vscode
	const storedIDE = getPreference(PREFERENCE_KEY);
	const selectedIDE =
		storedIDE && IDE_CONFIGS.some((c) => c.id === storedIDE)
			? storedIDE
			: "vscode";

	// Save preference when changed
	const handleIDEChange = React.useCallback(
		(ideId: string) => {
			// Save to server (fire and forget, SWR will update local cache)
			setPreference(PREFERENCE_KEY, ideId).catch(() => {
				// Ignore errors (not authenticated, network issues, etc.)
			});
		},
		[setPreference],
	);

	// Get the selected IDE config
	const selectedConfig = React.useMemo(
		() => IDE_CONFIGS.find((c) => c.id === selectedIDE) || IDE_CONFIGS[0],
		[selectedIDE],
	);

	// Launch the IDE
	const launchIDE = React.useCallback(
		async (config: IDEConfig) => {
			const host = getSSHHost();
			const user = sessionId;
			const port = SSH_PORT;
			const path = WORKSPACE_PATH;

			// Use URL handler for both Tauri and browser modes
			const url = replacePlaceholders(
				config.urlTemplate,
				user,
				host,
				port,
				path,
			);
			await openUrl(url);
		},
		[sessionId],
	);

	// Handle main button click
	const handleMainClick = React.useCallback(() => {
		launchIDE(selectedConfig);
	}, [launchIDE, selectedConfig]);

	// Handle dropdown item click
	const handleItemClick = React.useCallback(
		(config: IDEConfig) => {
			handleIDEChange(config.id);
			launchIDE(config);
		},
		[handleIDEChange, launchIDE],
	);

	return (
		<div className={cn("flex items-center", className)}>
			{/* Split button group */}
			<div className="flex items-center rounded-md border border-border overflow-hidden">
				{/* Main button */}
				<Button
					variant="ghost"
					size="sm"
					className="h-6 px-2 text-xs rounded-none border-0 hover:bg-accent"
					onClick={handleMainClick}
					title={`Open in ${selectedConfig.name}`}
				>
					{selectedConfig.name}
				</Button>

				{/* Divider */}
				<div className="w-px h-4 bg-border" />

				{/* Dropdown trigger */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-1 rounded-none border-0 hover:bg-accent"
						>
							<ChevronDown className="h-3 w-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-[120px]">
						{IDE_CONFIGS.map((config) => (
							<DropdownMenuItem
								key={config.id}
								onClick={() => handleItemClick(config)}
								className={cn(
									"text-xs cursor-pointer",
									config.id === selectedIDE && "bg-accent",
								)}
							>
								{config.name}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
