import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	isTextFile,
	listDirectory,
	readFile,
	validatePath,
	writeFile as writeFileOp,
} from "./files.js";

describe("validatePath", () => {
	const workspaceRoot = "/workspace";

	describe("valid paths", () => {
		it("allows empty path (root)", () => {
			assert.equal(validatePath("", workspaceRoot), resolve(workspaceRoot));
		});

		it("allows dot path (root)", () => {
			assert.equal(validatePath(".", workspaceRoot), resolve(workspaceRoot));
		});

		it("allows simple relative path", () => {
			assert.equal(
				validatePath("src/index.ts", workspaceRoot),
				resolve(workspaceRoot, "src/index.ts"),
			);
		});

		it("allows nested relative path", () => {
			assert.equal(
				validatePath("src/components/Button.tsx", workspaceRoot),
				resolve(workspaceRoot, "src/components/Button.tsx"),
			);
		});

		it("allows path with ./  prefix", () => {
			assert.equal(
				validatePath("./src/index.ts", workspaceRoot),
				resolve(workspaceRoot, "src/index.ts"),
			);
		});
	});

	describe("directory traversal prevention", () => {
		it("rejects simple .. traversal", () => {
			assert.equal(validatePath("../etc/passwd", workspaceRoot), null);
		});

		it("rejects nested .. traversal", () => {
			assert.equal(validatePath("src/../../etc/passwd", workspaceRoot), null);
		});

		it("rejects deep .. traversal", () => {
			assert.equal(validatePath("a/b/c/../../../..", workspaceRoot), null);
		});

		it("allows .. that stays within workspace", () => {
			assert.equal(
				validatePath("src/../lib/utils.ts", workspaceRoot),
				resolve(workspaceRoot, "lib/utils.ts"),
			);
		});
	});

	describe("absolute path rejection", () => {
		it("rejects absolute path starting with /", () => {
			assert.equal(validatePath("/etc/passwd", workspaceRoot), null);
		});

		it("rejects absolute path starting with \\", () => {
			assert.equal(validatePath("\\etc\\passwd", workspaceRoot), null);
		});
	});
});

describe("isTextFile", () => {
	describe("known text extensions", () => {
		it("identifies TypeScript files", () => {
			assert.equal(isTextFile("index.ts"), true);
			assert.equal(isTextFile("component.tsx"), true);
		});

		it("identifies JavaScript files", () => {
			assert.equal(isTextFile("index.js"), true);
			assert.equal(isTextFile("index.mjs"), true);
			assert.equal(isTextFile("index.cjs"), true);
		});

		it("identifies config files", () => {
			assert.equal(isTextFile("package.json"), true);
			assert.equal(isTextFile("config.yaml"), true);
			assert.equal(isTextFile("config.yml"), true);
			assert.equal(isTextFile("config.toml"), true);
		});

		it("identifies markup files", () => {
			assert.equal(isTextFile("README.md"), true);
			assert.equal(isTextFile("index.html"), true);
			assert.equal(isTextFile("styles.css"), true);
		});

		it("identifies Python files", () => {
			assert.equal(isTextFile("script.py"), true);
		});

		it("identifies Go files", () => {
			assert.equal(isTextFile("main.go"), true);
		});

		it("identifies Rust files", () => {
			assert.equal(isTextFile("main.rs"), true);
		});
	});

	describe("known binary extensions", () => {
		it("identifies image files", () => {
			assert.equal(isTextFile("logo.png"), false);
			assert.equal(isTextFile("photo.jpg"), false);
			assert.equal(isTextFile("photo.jpeg"), false);
			assert.equal(isTextFile("icon.gif"), false);
			assert.equal(isTextFile("image.webp"), false);
		});

		it("identifies font files", () => {
			assert.equal(isTextFile("font.woff"), false);
			assert.equal(isTextFile("font.woff2"), false);
			assert.equal(isTextFile("font.ttf"), false);
		});

		it("identifies archive files", () => {
			assert.equal(isTextFile("archive.zip"), false);
			assert.equal(isTextFile("archive.tar"), false);
			assert.equal(isTextFile("archive.gz"), false);
		});

		it("identifies executable files", () => {
			assert.equal(isTextFile("app.wasm"), false);
			assert.equal(isTextFile("module.node"), false);
		});
	});

	describe("extension-less files by name", () => {
		it("identifies Makefile as text", () => {
			assert.equal(isTextFile("Makefile"), true);
		});

		it("identifies Dockerfile as text", () => {
			assert.equal(isTextFile("Dockerfile"), true);
		});

		it("identifies LICENSE as text", () => {
			assert.equal(isTextFile("LICENSE"), true);
		});

		it("identifies README as text", () => {
			assert.equal(isTextFile("README"), true);
		});
	});

	describe("content inspection", () => {
		it("identifies text content without null bytes", () => {
			const textBuffer = Buffer.from("Hello, world!\nThis is text.");
			assert.equal(isTextFile("unknown.xyz", textBuffer), true);
		});

		it("identifies binary content with null bytes", () => {
			const binaryBuffer = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02,
			]);
			assert.equal(isTextFile("unknown.xyz", binaryBuffer), false);
		});

		it("defaults to text for unknown extension without content", () => {
			assert.equal(isTextFile("unknown.xyz"), true);
		});
	});
});

describe("listDirectory", () => {
	const testDir = "/tmp/agent-api-list-test";

	before(async () => {
		await mkdir(join(testDir, "src"), { recursive: true });
		await mkdir(join(testDir, "lib"), { recursive: true });
		await mkdir(join(testDir, ".hidden"), { recursive: true });
		await writeFile(join(testDir, "package.json"), '{"name": "test"}');
		await writeFile(join(testDir, "README.md"), "# Test");
		await writeFile(join(testDir, ".gitignore"), "node_modules");
		await writeFile(join(testDir, "src/index.ts"), "export const x = 1;");
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("lists root directory", async () => {
		const result = await listDirectory(".", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		assert.equal(result.path, ".");
		assert.ok(Array.isArray(result.entries));

		// Should have directories and files
		const names = result.entries.map((e) => e.name);
		assert.ok(names.includes("src"));
		assert.ok(names.includes("lib"));
		assert.ok(names.includes("package.json"));
		assert.ok(names.includes("README.md"));
	});

	it("excludes hidden files by default", async () => {
		const result = await listDirectory(".", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		const names = result.entries.map((e) => e.name);
		assert.ok(!names.includes(".gitignore"));
		assert.ok(!names.includes(".hidden"));
	});

	it("includes hidden files when requested", async () => {
		const result = await listDirectory(".", {
			workspaceRoot: testDir,
			includeHidden: true,
		});

		assert.ok(!("error" in result));
		const names = result.entries.map((e) => e.name);
		assert.ok(names.includes(".gitignore"));
		assert.ok(names.includes(".hidden"));
	});

	it("lists subdirectory", async () => {
		const result = await listDirectory("src", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		assert.equal(result.path, "src");
		assert.ok(result.entries.some((e) => e.name === "index.ts"));
	});

	it("sorts directories before files", async () => {
		const result = await listDirectory(".", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		const lastDir =
			result.entries.filter((e) => e.type === "directory").length - 1;
		const firstFile = result.entries.findIndex((e) => e.type === "file");

		// All directories should come before all files
		assert.ok(lastDir < firstFile || firstFile === -1);
	});

	it("includes file sizes", async () => {
		const result = await listDirectory(".", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		const packageJson = result.entries.find((e) => e.name === "package.json");
		assert.ok(packageJson);
		assert.ok(typeof packageJson.size === "number");
		assert.ok(packageJson.size > 0);
	});

	it("returns 400 for path traversal", async () => {
		const result = await listDirectory("../etc", { workspaceRoot: testDir });

		assert.ok("error" in result);
		assert.equal(result.status, 400);
		assert.equal(result.error, "Invalid path");
	});

	it("returns 404 for non-existent directory", async () => {
		const result = await listDirectory("nonexistent", {
			workspaceRoot: testDir,
		});

		assert.ok("error" in result);
		assert.equal(result.status, 404);
		assert.equal(result.error, "Directory not found");
	});

	it("returns 400 for file path", async () => {
		const result = await listDirectory("package.json", {
			workspaceRoot: testDir,
		});

		assert.ok("error" in result);
		assert.equal(result.status, 400);
		assert.equal(result.error, "Not a directory");
	});
});

describe("readFile", () => {
	const testDir = "/tmp/agent-api-read-test";

	before(async () => {
		await mkdir(testDir, { recursive: true });
		await writeFile(join(testDir, "text.txt"), "Hello, world!");
		await writeFile(join(testDir, "code.ts"), "export const x = 1;");
		// Create a small "binary" file with null bytes
		await writeFile(
			join(testDir, "binary.bin"),
			Buffer.from([0x00, 0x01, 0x02, 0x03]),
		);
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("reads text file as utf8", async () => {
		const result = await readFile("text.txt", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		assert.equal(result.path, "text.txt");
		assert.equal(result.content, "Hello, world!");
		assert.equal(result.encoding, "utf8");
		assert.equal(result.size, 13);
	});

	it("reads code file as utf8", async () => {
		const result = await readFile("code.ts", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		assert.equal(result.encoding, "utf8");
		assert.ok(result.content.includes("export const x"));
	});

	it("reads binary file as base64", async () => {
		const result = await readFile("binary.bin", { workspaceRoot: testDir });

		assert.ok(!("error" in result));
		assert.equal(result.encoding, "base64");
		// Decode and verify
		const decoded = Buffer.from(result.content, "base64");
		assert.deepEqual(decoded, Buffer.from([0x00, 0x01, 0x02, 0x03]));
	});

	it("returns 400 for path traversal", async () => {
		const result = await readFile("../etc/passwd", { workspaceRoot: testDir });

		assert.ok("error" in result);
		assert.equal(result.status, 400);
		assert.equal(result.error, "Invalid path");
	});

	it("returns 404 for non-existent file", async () => {
		const result = await readFile("nonexistent.txt", {
			workspaceRoot: testDir,
		});

		assert.ok("error" in result);
		assert.equal(result.status, 404);
		assert.equal(result.error, "File not found");
	});

	it("returns 400 for directory path", async () => {
		await mkdir(join(testDir, "subdir"), { recursive: true });
		const result = await readFile("subdir", { workspaceRoot: testDir });

		assert.ok("error" in result);
		assert.equal(result.status, 400);
		assert.equal(result.error, "Is a directory");
	});

	it("respects maxSize limit", async () => {
		// Create a file larger than our tiny limit
		await writeFile(join(testDir, "large.txt"), "x".repeat(100));
		const result = await readFile("large.txt", {
			workspaceRoot: testDir,
			maxSize: 50,
		});

		assert.ok("error" in result);
		assert.equal(result.status, 413);
		assert.equal(result.error, "File too large");
	});
});

describe("writeFile", () => {
	const testDir = "/tmp/agent-api-write-test";

	before(async () => {
		await mkdir(testDir, { recursive: true });
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("writes text file", async () => {
		const result = await writeFileOp("new-file.txt", "Hello, world!", "utf8", {
			workspaceRoot: testDir,
		});

		assert.ok(!("error" in result));
		assert.equal(result.path, "new-file.txt");
		assert.equal(result.size, 13);

		// Verify file was written
		const readResult = await readFile("new-file.txt", {
			workspaceRoot: testDir,
		});
		assert.ok(!("error" in readResult));
		assert.equal(readResult.content, "Hello, world!");
	});

	it("writes base64 encoded content", async () => {
		const content = Buffer.from("Binary content").toString("base64");
		const result = await writeFileOp("binary-write.bin", content, "base64", {
			workspaceRoot: testDir,
		});

		assert.ok(!("error" in result));
		assert.equal(result.size, 14); // "Binary content" is 14 bytes

		// Verify file was written
		const readResult = await readFile("binary-write.bin", {
			workspaceRoot: testDir,
		});
		assert.ok(!("error" in readResult));
	});

	it("creates parent directories", async () => {
		const result = await writeFileOp(
			"deep/nested/path/file.txt",
			"nested content",
			"utf8",
			{
				workspaceRoot: testDir,
			},
		);

		assert.ok(!("error" in result));
		assert.equal(result.path, join("deep", "nested", "path", "file.txt"));

		// Verify file was written
		const readResult = await readFile("deep/nested/path/file.txt", {
			workspaceRoot: testDir,
		});
		assert.ok(!("error" in readResult));
		assert.equal(readResult.content, "nested content");
	});

	it("overwrites existing file", async () => {
		// Write initial content
		await writeFileOp("overwrite.txt", "initial", "utf8", {
			workspaceRoot: testDir,
		});

		// Overwrite
		const result = await writeFileOp("overwrite.txt", "updated", "utf8", {
			workspaceRoot: testDir,
		});

		assert.ok(!("error" in result));

		// Verify content was updated
		const readResult = await readFile("overwrite.txt", {
			workspaceRoot: testDir,
		});
		assert.ok(!("error" in readResult));
		assert.equal(readResult.content, "updated");
	});

	it("returns 400 for path traversal", async () => {
		const result = await writeFileOp("../escape.txt", "malicious", "utf8", {
			workspaceRoot: testDir,
		});

		assert.ok("error" in result);
		assert.equal(result.status, 400);
		assert.equal(result.error, "Invalid path");
	});
});
