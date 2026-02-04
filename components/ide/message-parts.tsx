import type { DynamicToolUIPart, FileUIPart, UIMessage } from "ai";
import { ImageAttachment } from "@/components/ai-elements/image-attachment";
import { MessageResponse } from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/sources";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";

interface ReasoningPart {
	type: "reasoning";
	text: string;
}

interface SourceUrlPart {
	type: "source-url";
	url: string;
	title?: string;
}

interface DocumentSourcePart {
	type: "source-document";
	sourceId: string;
	title?: string;
	mediaType?: string;
}

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
 */
export function MessagePart({
	message,
	partIdx,
	part,
	isStreaming = false,
}: MessagePartsProps) {
	// Text part
	if (part.type === "text") {
		return (
			<MessageResponse key={`text-${partIdx}`}>{part.text}</MessageResponse>
		);
	}

	// Reasoning part (thinking blocks)
	if (part.type === "reasoning") {
		const reasoningPart = part as ReasoningPart;
		// Check if this is the last part and streaming to show spinner
		const isThisPartStreaming =
			isStreaming && partIdx === message.parts.length - 1;

		return (
			<Reasoning key={`reasoning-${partIdx}`} isStreaming={isThisPartStreaming}>
				<ReasoningTrigger />
				<ReasoningContent>{reasoningPart.text}</ReasoningContent>
			</Reasoning>
		);
	}

	// File part (images and file attachments)
	if (part.type === "file") {
		const filePart = part as FileUIPart;
		if (filePart.mediaType?.startsWith("image/")) {
			return (
				<ImageAttachment
					key={`file-${partIdx}`}
					src={filePart.url}
					filename={filePart.filename}
				/>
			);
		}
		// Non-image file attachment
		return (
			<div
				key={`file-${partIdx}`}
				className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
			>
				<span className="text-muted-foreground">📎 {filePart.filename}</span>
			</div>
		);
	}

	// Dynamic tool part (tool calls)
	if (part.type === "dynamic-tool") {
		const toolPart = part as DynamicToolUIPart;
		return (
			<Tool key={toolPart.toolCallId}>
				<ToolHeader
					type={toolPart.type}
					state={toolPart.state}
					toolName={toolPart.toolName}
					title={toolPart.title}
				/>
				<ToolContent>
					<ToolInput input={toolPart.input} />
					<ToolOutput output={toolPart.output} errorText={toolPart.errorText} />
				</ToolContent>
			</Tool>
		);
	}

	// Source URL part (RAG citations)
	if (part.type === "source-url") {
		const sourcePart = part as SourceUrlPart;
		return (
			<Source
				key={`source-url-${partIdx}`}
				href={sourcePart.url}
				title={sourcePart.title || new URL(sourcePart.url).hostname}
			/>
		);
	}

	// Document source part (RAG citations)
	if (part.type === "source-document") {
		const docPart = part as DocumentSourcePart;
		return (
			<div
				key={`document-${partIdx}`}
				className="flex flex-col gap-1 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm"
			>
				<span className="font-medium text-foreground">
					{docPart.title || docPart.sourceId}
				</span>
				{docPart.mediaType && (
					<span className="text-xs text-muted-foreground">
						{docPart.mediaType}
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
}
