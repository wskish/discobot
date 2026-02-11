import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { messageToContentBlocks, parseDataUrl } from "./content-blocks.js";

describe("content-blocks", () => {
	describe("parseDataUrl", () => {
		it("parses valid PNG data URL", () => {
			const dataUrl =
				"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
			const result = parseDataUrl(dataUrl);

			assert.ok(result);
			assert.strictEqual(result.mediaType, "image/png");
			assert.strictEqual(
				result.data,
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			);
		});

		it("parses valid JPEG data URL", () => {
			const dataUrl = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
			const result = parseDataUrl(dataUrl);

			assert.ok(result);
			assert.strictEqual(result.mediaType, "image/jpeg");
			assert.strictEqual(result.data, "/9j/4AAQSkZJRg==");
		});

		it("parses valid WebP data URL", () => {
			const dataUrl = "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAw";
			const result = parseDataUrl(dataUrl);

			assert.ok(result);
			assert.strictEqual(result.mediaType, "image/webp");
			assert.strictEqual(result.data, "UklGRiQAAABXRUJQVlA4IBgAAAAw");
		});

		it("returns null for invalid data URL format", () => {
			const invalidUrl = "not-a-data-url";
			const result = parseDataUrl(invalidUrl);

			assert.strictEqual(result, null);
		});

		it("returns null for data URL without base64 encoding", () => {
			const textUrl = "data:text/plain,hello";
			const result = parseDataUrl(textUrl);

			assert.strictEqual(result, null);
		});

		it("returns null for blob URL", () => {
			const blobUrl = "blob:http://localhost:3000/abc-123";
			const result = parseDataUrl(blobUrl);

			assert.strictEqual(result, null);
		});

		it("returns null for http URL", () => {
			const httpUrl = "https://example.com/image.png";
			const result = parseDataUrl(httpUrl);

			assert.strictEqual(result, null);
		});

		it("handles data URL with empty base64 content", () => {
			const emptyUrl = "data:image/png;base64,";
			const result = parseDataUrl(emptyUrl);

			assert.ok(result);
			assert.strictEqual(result.mediaType, "image/png");
			assert.strictEqual(result.data, "");
		});
	});

	describe("messageToContentBlocks", () => {
		it("converts text-only message", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "Hello, world!" }],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "Hello, world!");
		});

		it("converts multiple text parts", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{ type: "text", text: "First paragraph." },
					{ type: "text", text: "Second paragraph." },
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 2);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "First paragraph.");
			assert.strictEqual(blocks[1].type, "text");
			assert.strictEqual(blocks[1].text, "Second paragraph.");
		});

		it("converts image file part to image content block", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "data:image/png;base64,iVBORw0KGgo=",
						mediaType: "image/png",
						filename: "test.png",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "image");
			if (blocks[0].type === "image") {
				assert.strictEqual(blocks[0].source.type, "base64");
				assert.strictEqual(blocks[0].source.media_type, "image/png");
				assert.strictEqual(blocks[0].source.data, "iVBORw0KGgo=");
			}
		});

		it("converts message with text and image", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{ type: "text", text: "Check out this image:" },
					{
						type: "file",
						url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
						mediaType: "image/jpeg",
						filename: "photo.jpg",
					},
					{ type: "text", text: "What do you think?" },
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 3);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "Check out this image:");
			assert.strictEqual(blocks[1].type, "image");
			if (blocks[1].type === "image") {
				assert.strictEqual(blocks[1].source.media_type, "image/jpeg");
			}
			assert.strictEqual(blocks[2].type, "text");
			assert.strictEqual(blocks[2].text, "What do you think?");
		});

		it("converts multiple images", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "data:image/png;base64,ABC123",
						mediaType: "image/png",
						filename: "first.png",
					},
					{
						type: "file",
						url: "data:image/jpeg;base64,XYZ789",
						mediaType: "image/jpeg",
						filename: "second.jpg",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 2);
			assert.strictEqual(blocks[0].type, "image");
			assert.strictEqual(blocks[1].type, "image");
			if (blocks[0].type === "image") {
				assert.strictEqual(blocks[0].source.media_type, "image/png");
				assert.strictEqual(blocks[0].source.data, "ABC123");
			}
			if (blocks[1].type === "image") {
				assert.strictEqual(blocks[1].source.media_type, "image/jpeg");
				assert.strictEqual(blocks[1].source.data, "XYZ789");
			}
		});

		it("skips file with invalid data URL", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{ type: "text", text: "Before" },
					{
						type: "file",
						url: "not-a-data-url",
						mediaType: "image/png",
						filename: "invalid.png",
					},
					{ type: "text", text: "After" },
				],
			};

			const blocks = messageToContentBlocks(message);

			// Should skip the invalid image but keep text blocks
			assert.strictEqual(blocks.length, 2);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "Before");
			assert.strictEqual(blocks[1].type, "text");
			assert.strictEqual(blocks[1].text, "After");
		});

		it("skips non-image file attachments", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{ type: "text", text: "Here is a PDF:" },
					{
						type: "file",
						url: "data:application/pdf;base64,JVBERi0xLjQ=",
						mediaType: "application/pdf",
						filename: "document.pdf",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			// Should skip the PDF and only include the text
			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "Here is a PDF:");
		});

		it("skips file without URL", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{ type: "text", text: "Text before" },
					{
						type: "file",
						url: "", // Empty URL should be skipped
						mediaType: "image/png",
						filename: "no-url.png",
					},
					{ type: "text", text: "Text after" },
				],
			};

			const blocks = messageToContentBlocks(message);

			// Should skip the file with empty URL
			assert.strictEqual(blocks.length, 2);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[1].type, "text");
		});

		it("handles file without media type", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "data:image/png;base64,ABC=",
						mediaType: "", // Empty media type should be skipped
						filename: "no-type.png",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			// Should skip the file since mediaType is empty and doesn't start with "image/"
			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "");
		});

		it("returns empty text block for empty message", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "");
		});

		it("returns empty text block when all parts are skipped", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "invalid-url",
						mediaType: "image/png",
						filename: "bad.png",
					},
					{
						type: "file",
						url: "data:application/pdf;base64,ABC=",
						mediaType: "application/pdf",
						filename: "doc.pdf",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			// All files skipped, should return empty text block
			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "");
		});

		it("handles WebP images", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAw",
						mediaType: "image/webp",
						filename: "modern.webp",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "image");
			if (blocks[0].type === "image") {
				assert.strictEqual(blocks[0].source.media_type, "image/webp");
			}
		});

		it("handles GIF images", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [
					{
						type: "file",
						url: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
						mediaType: "image/gif",
						filename: "animation.gif",
					},
				],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "image");
			if (blocks[0].type === "image") {
				assert.strictEqual(blocks[0].source.media_type, "image/gif");
			}
		});

		it("preserves empty text blocks", () => {
			const message: UIMessage = {
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "" }],
			};

			const blocks = messageToContentBlocks(message);

			assert.strictEqual(blocks.length, 1);
			assert.strictEqual(blocks[0].type, "text");
			assert.strictEqual(blocks[0].text, "");
		});
	});
});
