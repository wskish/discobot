import { Circle, Loader2, XCircle } from "lucide-react";
import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Service } from "@/lib/api-types";
import { cn } from "@/lib/utils";

/**
 * Build the service preview URL for a given session and service.
 * Uses subdomain format: {session-id}-svc-{service-id}.{host}
 */
function getServiceUrl(
	sessionId: string,
	serviceId: string,
	urlPath?: string,
	useHttps = false,
): string {
	if (typeof window === "undefined") return "";

	const currentHost = window.location.host;
	const subdomain = `${sessionId}-svc-${serviceId}`;

	let baseUrl: string;
	// Check if we're in Next.js dev mode (localhost:3000)
	// In that case, connect directly to Go backend on port 3001
	if (
		currentHost === "localhost:3000" ||
		currentHost.startsWith("localhost:3000")
	) {
		const protocol = useHttps ? "https:" : "http:";
		baseUrl = `${protocol}//${subdomain}.localhost:3001`;
	} else {
		// Production or Tauri - use same host with subdomain
		const protocol = useHttps ? "https:" : window.location.protocol;
		baseUrl = `${protocol}//${subdomain}.${currentHost}`;
	}

	// Add path if specified
	const path = urlPath
		? urlPath.startsWith("/")
			? urlPath
			: `/${urlPath}`
		: "/";
	return `${baseUrl}${path}`;
}

interface ServiceButtonProps {
	service: Service;
	sessionId: string;
	isActive: boolean;
	onSelect: () => void;
	onStart: () => void;
}

export function ServiceButton({
	service,
	sessionId,
	isActive,
	onSelect,
	onStart,
}: ServiceButtonProps) {
	const handleClick = (e: React.MouseEvent) => {
		// Allow ctrl+click / cmd+click to open in new tab (default anchor behavior)
		if (e.ctrlKey || e.metaKey) {
			return;
		}

		// Prevent navigation for normal clicks
		e.preventDefault();

		// If stopped and not passive, start it first
		if (service.status === "stopped" && !service.passive) {
			onStart();
		}
		// Always show the output panel
		onSelect();
	};

	// Build the service URL for the href
	const serviceUrl = React.useMemo(
		() =>
			getServiceUrl(sessionId, service.id, service.urlPath, !!service.https),
		[sessionId, service.id, service.urlPath, service.https],
	);

	// Status indicator icon
	// Passive services always show as green (they're externally managed)
	const statusIcon = (() => {
		if (service.passive) {
			return <Circle className="h-2 w-2 fill-green-500 text-green-500" />;
		}

		switch (service.status) {
			case "running":
				return <Circle className="h-2 w-2 fill-green-500 text-green-500" />;
			case "starting":
			case "stopping":
				return <Loader2 className="h-2 w-2 animate-spin text-yellow-500" />;
			case "stopped":
				// Show error icon for non-zero exit code
				if (service.exitCode !== undefined && service.exitCode !== 0) {
					return <XCircle className="h-2.5 w-2.5 text-red-500" />;
				}
				return <Circle className="h-2 w-2 text-muted-foreground" />;
			default:
				return <Circle className="h-2 w-2 text-muted-foreground" />;
		}
	})();

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<a
					href={serviceUrl}
					className={cn(
						buttonVariants({
							variant: isActive ? "secondary" : "ghost",
							size: "sm",
						}),
						"h-6 text-xs gap-1",
					)}
					onClick={handleClick}
				>
					{statusIcon}
					{service.name}
				</a>
			</TooltipTrigger>
			<TooltipContent side="bottom">
				<div className="text-xs">
					{service.description && <p>{service.description}</p>}
					<p className="text-muted-foreground">
						{service.passive ? (
							<>External service on port {service.http || service.https}</>
						) : (
							<>
								Status: {service.status}
								{service.exitCode !== undefined &&
									` (exit: ${service.exitCode})`}
							</>
						)}
					</p>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}
