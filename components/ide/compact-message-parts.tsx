import type { UIMessage } from "ai";
import { ChevronDownIcon, ListIcon } from "lucide-react";
import React, { useMemo, useState } from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	formatPartsSummary,
	groupPartsByType,
	groupToolsByName,
} from "./compact-message-parts-utils";
import { MessagePart } from "./message-parts";

interface CompactMessagePartsProps {
	message: UIMessage;
	isStreaming: boolean;
}

/**
 * CompactMessageParts renders message parts with automatic compaction.
 *
 * For assistant messages with 2+ parts:
 * - All parts except the last one are collapsed into a summary
 * - The summary shows counts by type (e.g., "2 Reads, 3 Writes, 1 text block, 1 reasoning block")
 * - Clicking the summary expands to show all parts
 * - Only the last part remains visible (typically the final result)
 *
 * During streaming, all parts are rendered normally to avoid premature summarization.
 */
export const CompactMessageParts = React.memo(function CompactMessageParts({
	message,
	isStreaming,
}: CompactMessagePartsProps) {
	const totalParts = message.parts.length;

	// Don't collapse if any part is awaiting approval (user needs to interact)
	const hasActiveApproval = message.parts.some(
		(part) =>
			part.type === "dynamic-tool" && part.state === "approval-requested",
	);

	// Don't use compact view if:
	// 1. Message is still streaming (avoid premature summary)
	// 2. There are 0-1 parts (no benefit to compacting)
	// 3. Any part needs user approval (keep it visible)
	const shouldUseCompactView =
		!isStreaming && !hasActiveApproval && totalParts >= 2;

	// If not using compact view, render all parts normally
	if (!shouldUseCompactView) {
		return (
			<>
				{message.parts.map((part, partIdx) => (
					<MessagePart
						key={`${message.id}-part-${partIdx}`}
						message={message}
						partIdx={partIdx}
						part={part}
						isStreaming={isStreaming}
					/>
				))}
			</>
		);
	}

	// Split into parts before last and the last part
	const partsBeforeLast = message.parts.slice(0, -1);
	const lastPart = message.parts[message.parts.length - 1];

	return (
		<>
			{/* Render collapsible summary for all parts except the last */}
			{partsBeforeLast.length > 0 && (
				<PartsSummary
					message={message}
					parts={partsBeforeLast}
					isStreaming={isStreaming}
				/>
			)}

			{/* Render the last part (always visible) */}
			{lastPart && (
				<MessagePart
					key={`${message.id}-part-${totalParts - 1}`}
					message={message}
					partIdx={totalParts - 1}
					part={lastPart}
					isStreaming={isStreaming}
				/>
			)}
		</>
	);
});

interface PartsSummaryProps {
	message: UIMessage;
	parts: UIMessage["parts"];
	isStreaming: boolean;
}

/**
 * PartsSummary renders a collapsible summary of message parts.
 *
 * Default state: collapsed
 * Displays: "X parts • 2 Reads • 1 Write • 1 text block • 1 reasoning block"
 * When expanded: shows all individual parts using MessagePart
 */
const PartsSummary = React.memo(function PartsSummary({
	message,
	parts,
	isStreaming,
}: PartsSummaryProps) {
	const [isOpen, setIsOpen] = useState(false);

	// Compute part type counts and tool counts
	const { partCounts, toolCounts, totalParts } = useMemo(() => {
		const partCounts = groupPartsByType(parts);
		const toolCounts = groupToolsByName(parts);
		const totalParts = parts.length;

		return { partCounts, toolCounts, totalParts };
	}, [parts]);

	const summaryText = useMemo(() => {
		return formatPartsSummary(partCounts, toolCounts);
	}, [partCounts, toolCounts]);

	return (
		<Collapsible
			defaultOpen={false}
			open={isOpen}
			onOpenChange={setIsOpen}
			className="group not-prose mb-4 w-full rounded-md border border-transparent hover:border-border data-[state=open]:border-border transition-all duration-200"
		>
			<CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3 hover:bg-muted/30 transition-all duration-200">
				<div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100 transition-all duration-200">
					<ListIcon className="size-4 text-muted-foreground" />
					<span className="font-medium text-sm">
						{totalParts} part{totalParts !== 1 ? "s" : ""}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground text-xs">{summaryText}</span>
					<ChevronDownIcon className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100 transition-all duration-200 group-data-[state=open]:rotate-180" />
				</div>
			</CollapsibleTrigger>

			<CollapsibleContent className="border-t bg-muted/20 px-3 py-2">
				<div className="space-y-2">
					{parts.map((part, idx) => (
						<MessagePart
							key={`${message.id}-part-${idx}`}
							message={message}
							partIdx={idx}
							part={part}
							isStreaming={isStreaming}
						/>
					))}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
});
