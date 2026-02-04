import { CheckCircle, Loader2 } from "lucide-react";
import * as React from "react";
import {
	QueueItem,
	QueueItemContent,
	QueueItemDescription,
	QueueItemIndicator,
	QueueList,
	QueueSection,
	QueueSectionContent,
	QueueSectionLabel,
	QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Plan entry structure from TodoWrite tool
export interface PlanEntry {
	content: string;
	status: "pending" | "in_progress" | "completed";
	activeForm: string;
	priority?: "low" | "medium" | "high";
}

// Context for sharing state between button and panel
interface QueueContextValue {
	isExpanded: boolean;
	toggle: () => void;
	completedCount: number;
	totalCount: number;
}

const QueueContext = React.createContext<QueueContextValue | null>(null);

/**
 * Hook to access queue context. Returns null when used outside ChatPlanQueue
 * or when plan is empty (since provider isn't mounted in that case).
 */
function useQueue() {
	return React.useContext(QueueContext);
}

interface ChatPlanQueueProps {
	/** The current plan entries */
	plan: PlanEntry[] | null;
	/** Children to render (typically QueueButton and QueuePanel) */
	children?: React.ReactNode;
}

/**
 * ChatPlanQueue - Collapsible todo/plan queue using compound component pattern
 * Usage:
 *   <ChatPlanQueue plan={plan}>
 *     <QueueButton /> // rendered in footer
 *     <QueuePanel />  // rendered above input when expanded
 *   </ChatPlanQueue>
 */
export function ChatPlanQueue({ plan, children }: ChatPlanQueueProps) {
	const [isExpanded, setIsExpanded] = React.useState(false);

	const completedCount = React.useMemo(
		() => plan?.filter((e) => e.status === "completed").length ?? 0,
		[plan],
	);
	const totalCount = plan?.length ?? 0;

	const toggle = React.useCallback(() => {
		setIsExpanded((prev) => !prev);
	}, []);

	const contextValue: QueueContextValue = React.useMemo(
		() => ({
			isExpanded,
			toggle,
			completedCount,
			totalCount,
		}),
		[isExpanded, toggle, completedCount, totalCount],
	);

	// Early return after all hooks
	if (!plan || plan.length === 0) {
		// If children provided, render them without queue context
		// This ensures the input area is always visible even without a plan
		if (children) {
			return <>{children}</>;
		}
		return null;
	}

	// If children provided, use compound component pattern
	if (children) {
		return (
			<QueueContext.Provider value={contextValue}>
				{children}
			</QueueContext.Provider>
		);
	}

	// Default: inline rendering with button at top (legacy)
	return (
		<div className="border-t border-x-0 border-b-0 rounded-none shadow-none">
			<QueueSection>
				<QueueSectionTrigger>
					<QueueSectionLabel
						count={totalCount}
						label={`Todo (${completedCount} completed)`}
					/>
				</QueueSectionTrigger>
				<QueueSectionContent>
					<QueueList>
						{plan.map((entry, index) => {
							const isCompleted = entry.status === "completed";
							const isInProgress = entry.status === "in_progress";

							return (
								<QueueItem
									// biome-ignore lint/suspicious/noArrayIndexKey: Plan entries don't have unique IDs
									key={index}
									className={cn(isInProgress && "bg-blue-500/10")}
								>
									<div className="flex items-center gap-2">
										{isInProgress ? (
											<Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
										) : (
											<QueueItemIndicator completed={isCompleted} />
										)}
										<QueueItemContent completed={isCompleted}>
											{entry.content}
										</QueueItemContent>
									</div>
									{entry.priority && (
										<QueueItemDescription completed={isCompleted}>
											Priority: {entry.priority}
										</QueueItemDescription>
									)}
								</QueueItem>
							);
						})}
					</QueueList>
				</QueueSectionContent>
			</QueueSection>
		</div>
	);
}

/**
 * QueueButton - Minimal button showing progress (e.g., 4/5)
 * Renders in the input footer. Returns null when no plan is active.
 */
export const QueueButton = React.memo(function QueueButton() {
	const context = useQueue();

	// Don't render when outside provider (no plan)
	if (!context) {
		return null;
	}

	const { completedCount, totalCount, toggle } = context;

	return (
		<Button
			variant="ghost"
			className="gap-1.5 h-8 px-2"
			onClick={toggle}
			type="button"
		>
			<CheckCircle className="h-3.5 w-3.5" />
			<span className="text-xs font-medium">
				{completedCount}/{totalCount}
			</span>
		</Button>
	);
});

interface QueuePanelProps {
	/** Plan entries to display */
	plan: PlanEntry[];
}

/**
 * QueuePanel - Expanded panel showing full queue list
 * Renders above the input when expanded. Returns null when no plan is active.
 */
export const QueuePanel = React.memo(function QueuePanel({
	plan,
}: QueuePanelProps) {
	const context = useQueue();

	// Don't render when outside provider (no plan)
	if (!context) {
		return null;
	}

	const { isExpanded, completedCount } = context;

	if (!isExpanded) {
		return null;
	}

	return (
		<div className="mb-2 rounded-lg border bg-background shadow-sm animate-in slide-in-from-bottom-2">
			<QueueSection defaultOpen={true}>
				<QueueSectionTrigger>
					<QueueSectionLabel
						count={plan.length}
						label={`Todo (${completedCount} completed)`}
					/>
				</QueueSectionTrigger>
				<QueueSectionContent>
					<QueueList>
						{plan.map((entry, index) => {
							const isCompleted = entry.status === "completed";
							const isInProgress = entry.status === "in_progress";

							return (
								<QueueItem
									// biome-ignore lint/suspicious/noArrayIndexKey: Plan entries don't have unique IDs
									key={index}
									className={cn(isInProgress && "bg-blue-500/10")}
								>
									<div className="flex items-center gap-2">
										{isInProgress ? (
											<Loader2 className="h-3 w-3 text-blue-500 animate-spin shrink-0" />
										) : (
											<QueueItemIndicator completed={isCompleted} />
										)}
										<QueueItemContent completed={isCompleted}>
											{entry.content}
										</QueueItemContent>
									</div>
									{entry.priority && (
										<QueueItemDescription completed={isCompleted}>
											Priority: {entry.priority}
										</QueueItemDescription>
									)}
								</QueueItem>
							);
						})}
					</QueueList>
				</QueueSectionContent>
			</QueueSection>
		</div>
	);
});
