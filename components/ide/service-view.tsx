import { Globe, Terminal } from "lucide-react";
import * as React from "react";
import { ServiceOutput } from "@/components/ide/service-output";
import { WebPreviewSandbox } from "@/components/ide/web-preview-sandbox";
import { Button } from "@/components/ui/button";
import type { Service } from "@/lib/api-types";
import { cn } from "@/lib/utils";

type ViewMode = "preview" | "logs";

interface ServiceViewProps {
	sessionId: string;
	service: Service;
	className?: string;
}

/**
 * ServiceView renders the appropriate view for a service:
 * - For passive HTTP services: shows WebPreviewSandbox only (no logs)
 * - For HTTP services: shows WebPreviewSandbox with toggle to see logs
 * - For non-HTTP services: shows ServiceOutput (logs only)
 */
export function ServiceView({
	sessionId,
	service,
	className,
}: ServiceViewProps) {
	const hasHttp = service.http !== undefined || service.https !== undefined;
	const isPassive = service.passive === true;
	const [viewMode, setViewMode] = React.useState<ViewMode>(
		hasHttp ? "preview" : "logs",
	);

	// Track previous status to detect transitions to "running"
	const prevStatusRef = React.useRef(service.status);
	const [refreshKey, setRefreshKey] = React.useState(0);

	// Refresh the preview when service transitions to "running"
	React.useEffect(() => {
		const prevStatus = prevStatusRef.current;
		// Update ref immediately to capture rapid status changes
		prevStatusRef.current = service.status;

		if (prevStatus !== "running" && service.status === "running") {
			// Small delay to let the service actually start listening
			const timer = setTimeout(() => {
				setRefreshKey((k) => k + 1);
			}, 500);
			return () => clearTimeout(timer);
		}
	}, [service.status]);

	// If no HTTP port, just show logs (passive services always have HTTP)
	if (!hasHttp) {
		return (
			<ServiceOutput
				sessionId={sessionId}
				serviceId={service.id}
				className={className}
			/>
		);
	}

	// For passive HTTP services, show WebPreviewSandbox only (no logs available)
	if (isPassive) {
		return (
			<WebPreviewSandbox
				sessionId={sessionId}
				serviceId={service.id}
				https={service.https !== undefined}
				refreshKey={refreshKey}
				status={service.status}
				passive={true}
				defaultPath={service.urlPath}
				className={className}
			/>
		);
	}

	// For non-passive HTTP services, show WebPreviewSandbox with toggle to logs
	return (
		<div className={cn("flex flex-col h-full", className)}>
			{/* Tab bar */}
			<div className="flex items-center gap-1 px-2 py-1 border-b bg-muted/30 shrink-0">
				<Button
					variant={viewMode === "preview" ? "secondary" : "ghost"}
					size="sm"
					className="h-5 text-xs gap-1 px-2"
					onClick={() => setViewMode("preview")}
				>
					<Globe className="h-3 w-3" />
					Preview
				</Button>
				<Button
					variant={viewMode === "logs" ? "secondary" : "ghost"}
					size="sm"
					className="h-5 text-xs gap-1 px-2"
					onClick={() => setViewMode("logs")}
				>
					<Terminal className="h-3 w-3" />
					Logs
				</Button>
			</div>

			{/* Content */}
			<div className="flex-1 relative min-h-0">
				{/* WebPreviewSandbox - always mounted for HTTP services */}
				<div
					className={cn(
						"absolute inset-0",
						viewMode !== "preview" && "invisible pointer-events-none",
					)}
				>
					<WebPreviewSandbox
						sessionId={sessionId}
						serviceId={service.id}
						https={service.https !== undefined}
						refreshKey={refreshKey}
						status={service.status}
						defaultPath={service.urlPath}
						className="h-full"
					/>
				</div>

				{/* Logs */}
				<div
					className={cn(
						"absolute inset-0",
						viewMode !== "logs" && "invisible pointer-events-none",
					)}
				>
					<ServiceOutput
						sessionId={sessionId}
						serviceId={service.id}
						className="h-full"
					/>
				</div>
			</div>
		</div>
	);
}
