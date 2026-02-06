import type { UIMessage } from "ai";

/**
 * Supported image media types for Claude SDK
 */
export type ImageMediaType =
	| "image/jpeg"
	| "image/png"
	| "image/gif"
	| "image/webp";

/**
 * Content block format for Claude SDK messages
 */
export type ContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: {
				type: "base64";
				media_type: ImageMediaType;
				data: string;
			};
	  };

/**
 * Extract base64 data and media type from a data URL
 * @param dataUrl - Data URL in format "data:image/png;base64,..."
 * @returns Object with mediaType and base64 data, or null if not a valid data URL
 */
export function parseDataUrl(
	dataUrl: string,
): { mediaType: string; data: string } | null {
	const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
	if (!match) return null;
	return {
		mediaType: match[1],
		data: match[2],
	};
}

/**
 * Check if a media type is a supported image format
 */
function isValidImageMediaType(mediaType: string): mediaType is ImageMediaType {
	return (
		mediaType === "image/jpeg" ||
		mediaType === "image/png" ||
		mediaType === "image/gif" ||
		mediaType === "image/webp"
	);
}

/**
 * Convert UIMessage parts to Claude SDK content blocks format.
 * Handles text parts and file parts (images).
 *
 * @param message - The UIMessage to convert
 * @returns Array of content blocks in Claude SDK format
 */
export function messageToContentBlocks(message: UIMessage): ContentBlock[] {
	const contentBlocks: ContentBlock[] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			contentBlocks.push({
				type: "text",
				text: part.text,
			});
		} else if (part.type === "file" && part.url) {
			// Check if this is an image file
			const mediaType = part.mediaType || "";
			if (mediaType.startsWith("image/")) {
				// Parse the data URL to extract base64 data
				const parsed = parseDataUrl(part.url);
				if (parsed && isValidImageMediaType(parsed.mediaType)) {
					contentBlocks.push({
						type: "image",
						source: {
							type: "base64",
							media_type: parsed.mediaType,
							data: parsed.data,
						},
					});
				} else if (parsed) {
					console.warn(
						`[SDK] Skipping image file with unsupported format: ${part.filename || "unknown"} (${parsed.mediaType})`,
					);
				} else {
					console.warn(
						`[SDK] Skipping image file with invalid data URL: ${part.filename || "unknown"}`,
					);
				}
			} else {
				// Non-image files are not supported by Claude SDK in prompt
				console.warn(
					`[SDK] Skipping non-image file attachment: ${part.filename || "unknown"} (${mediaType})`,
				);
			}
		}
	}

	// If no content blocks were created, add an empty text block to avoid errors
	if (contentBlocks.length === 0) {
		contentBlocks.push({ type: "text", text: "" });
	}

	return contentBlocks;
}
