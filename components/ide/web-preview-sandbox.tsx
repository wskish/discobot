import { AlertCircle, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getApiRootBase } from "@/lib/api-config";
import type { ServiceStatus } from "@/lib/api-types";
import { openUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface WebPreviewSandboxProps {
	/** Session ID for the sandbox */
	sessionId: string;
	/** Service ID */
	serviceId: string;
	/** Whether to use HTTPS (default: false) */
	https?: boolean;
	/** Additional CSS classes */
	className?: string;
	/** Refresh key - change this to force a refresh */
	refreshKey?: number;
	/** Current service status */
	status?: ServiceStatus;
	/** Whether this is a passive (externally managed) service */
	passive?: boolean;
	/** Default URL path (from service config) */
	defaultPath?: string;
}

/**
 * WebPreviewSandbox renders an iframe that connects to a service's HTTP endpoint
 * via the subdomain proxy: {session-id}-svc-{service-id}.{host}
 *
 * For connection errors, the proxy returns an HTML page that auto-refreshes,
 * so the UI doesn't need to handle retry logic.
 */
export function WebPreviewSandbox({
	sessionId,
	serviceId,
	https: useHttps = false,
	className,
	refreshKey = 0,
	status = "running",
	passive = false,
	defaultPath = "/",
}: WebPreviewSandboxProps) {
	const iframeRef = React.useRef<HTMLIFrameElement>(null);
	const [isLoading, setIsLoading] = React.useState(true);
	const [error, setError] = React.useState<string | null>(null);
	const [internalKey, setInternalKey] = React.useState(0);
	const [currentPath, setCurrentPath] = React.useState(defaultPath || "/");
	const [inputPath, setInputPath] = React.useState(defaultPath || "/");

	// Combine external refreshKey with internal key for total refresh count
	const key = refreshKey + internalKey;

	// Build the base service URL (without path)
	// Derives from getApiRootBase() origin, replacing the host with a subdomain proxy
	const baseUrl = React.useMemo(() => {
		if (typeof window === "undefined") return "";

		const apiRoot = getApiRootBase();
		const parsed = new URL(apiRoot);
		const subdomain = `${sessionId}-svc-${serviceId}`;
		const protocol = useHttps ? "https:" : parsed.protocol;

		return `${protocol}//${subdomain}.${parsed.host}`;
	}, [sessionId, serviceId, useHttps]);

	// Full URL with path
	const serviceUrl = React.useMemo(() => {
		if (!baseUrl) return "";
		// Ensure path starts with /
		const path = currentPath.startsWith("/") ? currentPath : `/${currentPath}`;
		return `${baseUrl}${path}`;
	}, [baseUrl, currentPath]);

	const handleRefresh = React.useCallback(() => {
		setIsLoading(true);
		setError(null);
		setInternalKey((k) => k + 1);
	}, []);

	const handleOpenExternal = React.useCallback(() => {
		openUrl(serviceUrl);
	}, [serviceUrl]);

	const handleLoad = React.useCallback(() => {
		setIsLoading(false);
		setError(null);
	}, []);

	const handleError = React.useCallback(() => {
		setIsLoading(false);
		setError("Failed to load service");
	}, []);

	const handlePathSubmit = React.useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			// Normalize the path
			let path = inputPath.trim();
			if (!path) path = "/";
			if (!path.startsWith("/")) path = `/${path}`;
			setCurrentPath(path);
			setInputPath(path);
			setIsLoading(true);
			setError(null);
			setInternalKey((k) => k + 1);
		},
		[inputPath],
	);

	const handlePathKeyDown = React.useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter") {
				handlePathSubmit(e);
			}
		},
		[handlePathSubmit],
	);

	// Determine if we should show the iframe
	const shouldShowIframe = passive || status === "running";

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{/* Toolbar */}
			<div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/50 shrink-0">
				<form
					onSubmit={handlePathSubmit}
					className="flex-1 flex items-center gap-1"
				>
					<span className="text-xs text-muted-foreground font-mono truncate shrink-0">
						{baseUrl}
					</span>
					<Input
						value={inputPath}
						onChange={(e) => setInputPath(e.target.value)}
						onKeyDown={handlePathKeyDown}
						className="h-5 text-xs font-mono px-1 py-0 min-w-[60px] flex-1"
						placeholder="/"
					/>
				</form>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 shrink-0"
					onClick={handleRefresh}
					title="Refresh"
				>
					<RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6 shrink-0"
					onClick={handleOpenExternal}
					title="Open in new tab"
				>
					<ExternalLink className="h-3 w-3" />
				</Button>
			</div>

			{/* Content area */}
			<div className="flex-1 relative min-h-0">
				{/* Service not running state - only for non-passive services */}
				{!passive && status !== "running" && (
					<div className="absolute inset-0 flex items-center justify-center bg-background z-10">
						<div className="flex flex-col items-center gap-2 text-muted-foreground">
							{status === "starting" || status === "stopping" ? (
								<>
									<Loader2 className="h-6 w-6 animate-spin" />
									<span className="text-sm">
										{status === "starting"
											? "Service is starting..."
											: "Service is stopping..."}
									</span>
								</>
							) : (
								<>
									<AlertCircle className="h-6 w-6" />
									<span className="text-sm">Service is not running</span>
								</>
							)}
						</div>
					</div>
				)}

				{/* Loading overlay */}
				{shouldShowIframe && isLoading && (
					<div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10">
						<div className="flex flex-col items-center gap-2">
							<RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
							<span className="text-sm text-muted-foreground">
								Loading service...
							</span>
						</div>
					</div>
				)}

				{/* Error state */}
				{shouldShowIframe && error && (
					<div className="absolute inset-0 flex items-center justify-center bg-background z-10">
						<div className="flex flex-col items-center gap-2 text-destructive">
							<AlertCircle className="h-6 w-6" />
							<span className="text-sm">{error}</span>
							<Button variant="outline" size="sm" onClick={handleRefresh}>
								Retry
							</Button>
						</div>
					</div>
				)}

				{/* Iframe - render for passive services or when service is running */}
				{shouldShowIframe && serviceUrl && (
					<iframe
						ref={iframeRef}
						key={`${key}-${currentPath}`}
						src={serviceUrl}
						className="w-full h-full border-0"
						onLoad={handleLoad}
						onError={handleError}
						title={`Service: ${serviceId}`}
						sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"
					/>
				)}
			</div>
		</div>
	);
}
