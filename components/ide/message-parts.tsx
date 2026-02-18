import type { UIMessage } from "ai";
import { lazy, memo, Suspense, useState } from "react";
import { ImageAttachment } from "@/components/ai-elements/image-attachment";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/sources";
import { Tool, ToolContent, ToolHeader } from "@/components/ai-elements/tool";
import {
	getToolTitle,
	hasOptimizedRenderer,
	OptimizedToolRenderer,
} from "@/components/ai-elements/tool-renderers";

const AskUserQuestionTool = lazy(
	() =>
		import("@/components/ai-elements/tool-renderers/ask-user-question-tool"),
);

interface MessagePartsProps {
	/** The message containing parts to render */
	message: UIMessage;
	/** Index of the current part being rendered */
	partIdx: number;
	/** The part to render */
	part: UIMessage["parts"][number];
	/** Whether this message is currently streaming */
	isStreaming?: boolean;
}

/**
 * OptimizedToolWrapper - Wraps optimized tool rendering with raw view toggle
 *
 * Manages the state for switching between optimized and raw view.
 */
function OptimizedToolWrapper({
	part,
}: {
	part: Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>;
}) {
	const [showRaw, setShowRaw] = useState(false);
	const isOptimized = hasOptimizedRenderer(part.toolName);
	const title = getToolTitle(part);

	// Special handling for AskUserQuestion — render inline question wizard
	if (part.toolName === "AskUserQuestion") {
		return (
			<Suspense
				fallback={
					<div className="animate-pulse bg-muted/50 rounded-md p-4 h-24" />
				}
			>
				<AskUserQuestionTool part={part} />
			</Suspense>
		);
	}

	return (
		<Tool key={part.toolCallId}>
			<ToolHeader
				type={part.type}
				state={part.state}
				toolName={part.toolName}
				title={title}
				showIcon={!isOptimized}
				isRaw={showRaw}
				onToggleRaw={isOptimized ? () => setShowRaw(!showRaw) : undefined}
			/>
			<ToolContent>
				<OptimizedToolRenderer toolPart={part} forceRaw={showRaw} />
			</ToolContent>
		</Tool>
	);
}

/**
 * MessageParts - Renders individual message parts based on type
 *
 * Handles all UIMessage part types from AI SDK v6:
 * - text: Plain text content
 * - reasoning: Thinking/reasoning blocks (collapsible)
 * - file: File attachments (images and files)
 * - dynamic-tool: Tool calls with input/output
 * - source-url: URL citations for RAG
 * - source-document: Document citations for RAG
 * - step-start: Step boundary marker (no visual render, used for logical grouping)
 *
 * Keeps chat-conversation.tsx simple by centralizing part rendering logic.
 *
 * Memoized to prevent unnecessary re-renders during streaming.
 */
export const MessagePart = memo(
	function MessagePart({
		message: _message,
		partIdx,
		part,
		isStreaming: _isStreaming = false,
	}: MessagePartsProps) {
		// Text part
		if (part.type === "text") {
			return (
				<MessageResponse key={`text-${partIdx}`}>{part.text}</MessageResponse>
			);
		}

		// Reasoning part (thinking blocks)
		if (part.type === "reasoning") {
			// Use the part's own state to determine if it's streaming
			const isThisPartStreaming = part.state === "streaming";

			return (
				<Reasoning
					key={`reasoning-${partIdx}`}
					isStreaming={isThisPartStreaming}
				>
					<ReasoningTrigger />
					<ReasoningContent>{part.text}</ReasoningContent>
				</Reasoning>
			);
		}

		// File part (images and file attachments)
		if (part.type === "file") {
			if (part.mediaType?.startsWith("image/")) {
				return (
					<ImageAttachment
						key={`file-${partIdx}`}
						src={part.url}
						filename={part.filename}
					/>
				);
			}
			// Non-image file attachment
			return (
				<div
					key={`file-${partIdx}`}
					className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
				>
					<span className="text-muted-foreground">📎 {part.filename}</span>
				</div>
			);
		}

		// Dynamic tool part (tool calls)
		if (part.type === "dynamic-tool") {
			return <OptimizedToolWrapper key={part.toolCallId} part={part} />;
		}

		// Source URL part (RAG citations)
		if (part.type === "source-url") {
			return (
				<Source
					key={`source-url-${partIdx}`}
					href={part.url}
					title={part.title || new URL(part.url).hostname}
				/>
			);
		}

		// Document source part (RAG citations)
		if (part.type === "source-document") {
			return (
				<div
					key={`document-${partIdx}`}
					className="flex flex-col gap-1 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
				>
					<span className="font-medium text-foreground">
						{part.title || part.sourceId}
					</span>
					{part.mediaType && (
						<span className="text-xs text-muted-foreground">
							{part.mediaType}
						</span>
					)}
				</div>
			);
		}

		// Step boundary parts - no visual rendering, just markers for logical grouping
		if (part.type === "step-start") {
			return null;
		}

		// Unknown part type - log warning and skip
		console.warn(`Unknown message part type: ${part.type}`, part);
		return null;
	},
	(prevProps, nextProps) => {
		// Custom comparison to avoid unnecessary re-renders
		// Only re-render if message ID, part index, streaming status, or part content changed

		if (prevProps.message.id !== nextProps.message.id) return false;
		if (prevProps.partIdx !== nextProps.partIdx) return false;
		if (prevProps.isStreaming !== nextProps.isStreaming) return false;

		const prevPart = prevProps.part;
		const nextPart = nextProps.part;

		// Quick checks for common cases
		if (prevPart === nextPart) return true; // Same reference
		if (prevPart.type !== nextPart.type) return false; // Type changed

		// If the current part is streaming, always re-render (skip expensive comparisons)
		if ("state" in nextPart && nextPart.state === "streaming") {
			return false;
		}

		// If parts have a state field, check if state changed (streaming vs done)
		// This handles text, reasoning, and other parts that track streaming state
		if ("state" in prevPart && "state" in nextPart) {
			if (prevPart.state !== nextPart.state) return false;
		}

		// For everything else, do a full comparison
		return JSON.stringify(prevPart) === JSON.stringify(nextPart);
	},
);
