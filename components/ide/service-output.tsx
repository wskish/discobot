import * as React from "react";
import { api } from "@/lib/api-client";
import type { ServiceOutputEvent } from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface ServiceOutputProps {
	sessionId: string;
	serviceId: string;
	className?: string;
}

export function ServiceOutput({
	sessionId,
	serviceId,
	className,
}: ServiceOutputProps) {
	const [events, setEvents] = React.useState<ServiceOutputEvent[]>([]);
	const [isConnected, setIsConnected] = React.useState(false);
	const outputRef = React.useRef<HTMLDivElement>(null);
	const eventSourceRef = React.useRef<EventSource | null>(null);

	// Connect to SSE stream
	React.useEffect(() => {
		// Clear events when service changes
		setEvents([]);

		const url = api.getServiceOutputUrl(sessionId, serviceId);
		const eventSource = new EventSource(url);
		eventSourceRef.current = eventSource;

		eventSource.onopen = () => {
			setIsConnected(true);
		};

		eventSource.onerror = () => {
			setIsConnected(false);
		};

		eventSource.onmessage = (event) => {
			if (event.data === "[DONE]") {
				eventSource.close();
				setIsConnected(false);
				return;
			}

			try {
				const parsed: ServiceOutputEvent = JSON.parse(event.data);
				setEvents((prev) => [...prev, parsed]);
			} catch (e) {
				console.error("Failed to parse service output event:", e);
			}
		};

		return () => {
			eventSource.close();
			eventSourceRef.current = null;
		};
	}, [sessionId, serviceId]);

	// Auto-scroll to bottom when events change
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally scroll when events array length changes
	React.useEffect(() => {
		if (outputRef.current) {
			outputRef.current.scrollTo(0, outputRef.current.scrollHeight);
		}
	}, [events.length]);

	return (
		<div
			ref={outputRef}
			className={cn(
				"font-mono text-sm overflow-auto p-2 bg-background text-foreground",
				className,
			)}
		>
			{events.length === 0 && !isConnected && (
				<div className="text-muted-foreground italic">No output yet</div>
			)}
			{events.map((event, i) => (
				<div
					key={`${event.timestamp}-${i}`}
					className={cn(
						"whitespace-pre-wrap break-all",
						event.type === "stderr" && "text-red-400",
						event.type === "exit" && "text-yellow-400 font-semibold mt-2",
						event.type === "error" && "text-red-500 font-semibold",
					)}
				>
					{event.data ||
						(event.type === "exit"
							? `Process exited with code ${event.exitCode}`
							: event.error)}
				</div>
			))}
		</div>
	);
}
