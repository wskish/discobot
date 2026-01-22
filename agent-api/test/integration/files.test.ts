import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import type {
	DiffFileEntry,
	DiffFilesResponse,
	DiffResponse,
	ErrorResponse,
	ListFilesResponse,
	ReadFileResponse,
	SingleFileDiffResponse,
	WriteFileResponse,
} from "../../src/api/types.js";
import { createApp } from "../../src/server/app.js";

const execAsync = promisify(exec);

describe("File System API Endpoints", () => {
	const testDir = "/tmp/agent-api-integration-files";
	let app: ReturnType<typeof createApp>["app"];

	before(async () => {
		// Clean up any existing test directory
		await rm(testDir, { recursive: true, force: true });

		// Create test directory structure
		await mkdir(join(testDir, "src/components"), { recursive: true });
		await mkdir(join(testDir, "lib"), { recursive: true });
		await mkdir(join(testDir, ".hidden"), { recursive: true });

		// Create test files
		await writeFile(join(testDir, "package.json"), '{"name": "test-project"}');
		await writeFile(
			join(testDir, "README.md"),
			"# Test Project\n\nThis is a test.",
		);
		await writeFile(join(testDir, ".gitignore"), "node_modules\ndist");
		await writeFile(join(testDir, ".env"), "SECRET=test123");
		await writeFile(
			join(testDir, "src/index.ts"),
			'export const main = () => "hello";',
		);
		await writeFile(
			join(testDir, "src/components/Button.tsx"),
			"export const Button = () => <button>Click</button>;",
		);

		// Create a binary-like file
		await writeFile(
			join(testDir, "binary.bin"),
			Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]),
		);

		// Create app with test directory as workspace root
		const result = createApp({
			agentCommand: "true",
			agentArgs: [],
			agentCwd: testDir,
			enableLogging: false,
		});
		app = result.app;
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	// =========================================================================
	// GET /files - Directory Listing
	// =========================================================================

	describe("GET /files", () => {
		it("lists root directory", async () => {
			const res = await app.request("/files?path=.");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			assert.equal(body.path, ".");
			assert.ok(Array.isArray(body.entries));

			// Check for expected entries
			const names = body.entries.map((e) => e.name);
			assert.ok(names.includes("src"), "Should include src directory");
			assert.ok(names.includes("lib"), "Should include lib directory");
			assert.ok(names.includes("package.json"), "Should include package.json");
			assert.ok(names.includes("README.md"), "Should include README.md");
		});

		it("defaults to root when path not provided", async () => {
			const res = await app.request("/files");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			assert.equal(body.path, ".");
		});

		it("excludes hidden files by default", async () => {
			const res = await app.request("/files?path=.");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			const names = body.entries.map((e) => e.name);

			assert.ok(!names.includes(".gitignore"), "Should not include .gitignore");
			assert.ok(!names.includes(".env"), "Should not include .env");
			assert.ok(
				!names.includes(".hidden"),
				"Should not include .hidden directory",
			);
		});

		it("includes hidden files when hidden=true", async () => {
			const res = await app.request("/files?path=.&hidden=true");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			const names = body.entries.map((e) => e.name);

			assert.ok(names.includes(".gitignore"), "Should include .gitignore");
			assert.ok(names.includes(".env"), "Should include .env");
			assert.ok(names.includes(".hidden"), "Should include .hidden directory");
		});

		it("lists subdirectory", async () => {
			const res = await app.request("/files?path=src");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			assert.equal(body.path, "src");

			const names = body.entries.map((e) => e.name);
			assert.ok(
				names.includes("components"),
				"Should include components directory",
			);
			assert.ok(names.includes("index.ts"), "Should include index.ts");
		});

		it("lists nested subdirectory", async () => {
			const res = await app.request("/files?path=src/components");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			assert.equal(body.path, "src/components");

			const names = body.entries.map((e) => e.name);
			assert.ok(names.includes("Button.tsx"), "Should include Button.tsx");
		});

		it("sorts directories before files", async () => {
			const res = await app.request("/files?path=.");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;

			// Find indices
			const directories = body.entries.filter((e) => e.type === "directory");
			const files = body.entries.filter((e) => e.type === "file");

			if (directories.length > 0 && files.length > 0) {
				const lastDirIndex = body.entries.findIndex(
					(e) => e.name === directories[directories.length - 1].name,
				);
				const firstFileIndex = body.entries.findIndex(
					(e) => e.name === files[0].name,
				);
				assert.ok(
					lastDirIndex < firstFileIndex,
					"All directories should come before files",
				);
			}
		});

		it("includes file sizes for files", async () => {
			const res = await app.request("/files?path=.");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			const packageJson = body.entries.find((e) => e.name === "package.json");

			assert.ok(packageJson, "Should find package.json");
			assert.equal(packageJson.type, "file");
			assert.ok(typeof packageJson.size === "number", "Should have size");
			assert.ok(packageJson.size > 0, "Size should be positive");
		});

		it("does not include size for directories", async () => {
			const res = await app.request("/files?path=.");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ListFilesResponse;
			const srcDir = body.entries.find((e) => e.name === "src");

			assert.ok(srcDir, "Should find src directory");
			assert.equal(srcDir.type, "directory");
			assert.equal(srcDir.size, undefined, "Directories should not have size");
		});

		it("returns 400 for path traversal attempt", async () => {
			const res = await app.request("/files?path=../etc");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Invalid path");
		});

		it("returns 400 for nested path traversal attempt", async () => {
			const res = await app.request("/files?path=src/../../etc");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Invalid path");
		});

		it("returns 404 for non-existent directory", async () => {
			const res = await app.request("/files?path=nonexistent");
			assert.equal(res.status, 404);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Directory not found");
		});

		it("returns 400 when path is a file", async () => {
			const res = await app.request("/files?path=package.json");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Not a directory");
		});
	});

	// =========================================================================
	// GET /files/read - Read File
	// =========================================================================

	describe("GET /files/read", () => {
		it("reads text file as utf8", async () => {
			const res = await app.request("/files/read?path=package.json");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ReadFileResponse;
			assert.equal(body.path, "package.json");
			assert.equal(body.encoding, "utf8");
			assert.ok(body.content.includes('"name": "test-project"'));
			assert.ok(body.size > 0);
		});

		it("reads TypeScript file", async () => {
			const res = await app.request("/files/read?path=src/index.ts");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ReadFileResponse;
			assert.equal(body.path, "src/index.ts");
			assert.equal(body.encoding, "utf8");
			assert.ok(body.content.includes("export const main"));
		});

		it("reads file from nested directory", async () => {
			const res = await app.request(
				"/files/read?path=src/components/Button.tsx",
			);
			assert.equal(res.status, 200);

			const body = (await res.json()) as ReadFileResponse;
			assert.equal(body.path, "src/components/Button.tsx");
			assert.ok(body.content.includes("Button"));
		});

		it("reads binary file as base64", async () => {
			const res = await app.request("/files/read?path=binary.bin");
			assert.equal(res.status, 200);

			const body = (await res.json()) as ReadFileResponse;
			assert.equal(body.path, "binary.bin");
			assert.equal(body.encoding, "base64");

			// Decode and verify content
			const decoded = Buffer.from(body.content, "base64");
			assert.deepEqual(decoded, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));
		});

		it("returns 400 when path parameter is missing", async () => {
			const res = await app.request("/files/read");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "path query parameter required");
		});

		it("returns 400 for path traversal attempt", async () => {
			const res = await app.request("/files/read?path=../etc/passwd");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Invalid path");
		});

		it("returns 404 for non-existent file", async () => {
			const res = await app.request("/files/read?path=nonexistent.txt");
			assert.equal(res.status, 404);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "File not found");
		});

		it("returns 400 when path is a directory", async () => {
			const res = await app.request("/files/read?path=src");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Is a directory");
		});
	});

	// =========================================================================
	// POST /files/write - Write File
	// =========================================================================

	describe("POST /files/write", () => {
		it("writes new text file", async () => {
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "new-file.txt",
					content: "Hello, world!",
				}),
			});
			assert.equal(res.status, 200);

			const body = (await res.json()) as WriteFileResponse;
			assert.equal(body.path, "new-file.txt");
			assert.equal(body.size, 13);

			// Verify file was written
			const readRes = await app.request("/files/read?path=new-file.txt");
			const readBody = (await readRes.json()) as ReadFileResponse;
			assert.equal(readBody.content, "Hello, world!");
		});

		it("writes file with base64 encoding", async () => {
			const binaryContent = Buffer.from([
				0x48, 0x65, 0x6c, 0x6c, 0x6f,
			]).toString("base64");

			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "base64-file.bin",
					content: binaryContent,
					encoding: "base64",
				}),
			});
			assert.equal(res.status, 200);

			const body = (await res.json()) as WriteFileResponse;
			assert.equal(body.path, "base64-file.bin");
			assert.equal(body.size, 5); // "Hello" is 5 bytes
		});

		it("creates parent directories automatically", async () => {
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "deep/nested/path/file.txt",
					content: "Nested content",
				}),
			});
			assert.equal(res.status, 200);

			const body = (await res.json()) as WriteFileResponse;
			assert.equal(body.path, "deep/nested/path/file.txt");

			// Verify file was written
			const readRes = await app.request(
				"/files/read?path=deep/nested/path/file.txt",
			);
			assert.equal(readRes.status, 200);
		});

		it("overwrites existing file", async () => {
			// Write initial content
			await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "overwrite-test.txt",
					content: "Original content",
				}),
			});

			// Overwrite
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "overwrite-test.txt",
					content: "Updated content",
				}),
			});
			assert.equal(res.status, 200);

			// Verify content was updated
			const readRes = await app.request("/files/read?path=overwrite-test.txt");
			const readBody = (await readRes.json()) as ReadFileResponse;
			assert.equal(readBody.content, "Updated content");
		});

		it("returns 400 when path is missing", async () => {
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: "Hello",
				}),
			});
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "path is required");
		});

		it("returns 400 when content is missing", async () => {
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "test.txt",
				}),
			});
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "content is required");
		});

		it("returns 400 for path traversal attempt", async () => {
			const res = await app.request("/files/write", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: "../escape.txt",
					content: "Malicious content",
				}),
			});
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Invalid path");
		});
	});

	// =========================================================================
	// GET /diff - Session Diff (basic tests without git)
	// =========================================================================

	describe("GET /diff", () => {
		it("returns diff response structure", async () => {
			const res = await app.request("/diff");
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffResponse;
			assert.ok(Array.isArray(body.files), "Should have files array");
			assert.ok(typeof body.stats === "object", "Should have stats object");
			assert.ok(typeof body.stats.filesChanged === "number");
			assert.ok(typeof body.stats.additions === "number");
			assert.ok(typeof body.stats.deletions === "number");
		});

		it("returns file list with format=files", async () => {
			const res = await app.request("/diff?format=files");
			assert.equal(res.status, 200);

			const body = await res.json();
			assert.ok(Array.isArray(body.files), "Should have files array");
			assert.ok(typeof body.stats === "object", "Should have stats object");
		});

		it("returns 400 for path traversal in single file diff", async () => {
			const res = await app.request("/diff?path=../etc/passwd");
			assert.equal(res.status, 400);

			const body = (await res.json()) as ErrorResponse;
			assert.equal(body.error, "Invalid path");
		});
	});
});

// =============================================================================
// Git Diff Integration Tests
// =============================================================================

describe("Git Diff API - All Change Types", () => {
	const gitTestDir = "/tmp/agent-api-git-diff-test";
	let app: ReturnType<typeof createApp>["app"];

	before(async () => {
		// Clean up any existing test directory
		await rm(gitTestDir, { recursive: true, force: true });

		// Create test directory
		await mkdir(gitTestDir, { recursive: true });

		// Initialize git repo
		await execAsync("git init", { cwd: gitTestDir });
		await execAsync('git config user.email "test@test.com"', {
			cwd: gitTestDir,
		});
		await execAsync('git config user.name "Test User"', { cwd: gitTestDir });

		// Create initial files and commit
		await writeFile(join(gitTestDir, "modified.txt"), "Original content\n");
		await writeFile(join(gitTestDir, "deleted.txt"), "This will be deleted\n");
		await writeFile(join(gitTestDir, "unchanged.txt"), "This stays the same\n");
		await mkdir(join(gitTestDir, "src"), { recursive: true });
		await writeFile(
			join(gitTestDir, "src/existing.ts"),
			"export const x = 1;\n",
		);

		// Create .gitignore to test that ignored files are excluded
		await writeFile(join(gitTestDir, ".gitignore"), "ignored.txt\n*.log\n");

		await execAsync("git add .", { cwd: gitTestDir });
		await execAsync('git commit -m "Initial commit"', { cwd: gitTestDir });

		// Now make changes:
		// 1. Modify a file
		await writeFile(
			join(gitTestDir, "modified.txt"),
			"Modified content\nWith new lines\n",
		);

		// 2. Delete a file
		await unlink(join(gitTestDir, "deleted.txt"));

		// 3. Create a new untracked file
		await writeFile(join(gitTestDir, "new-file.txt"), "This is a new file\n");

		// 4. Create a new file in a subdirectory
		await writeFile(
			join(gitTestDir, "src/new-component.ts"),
			"export const NewComponent = () => {};\n",
		);

		// 5. Create an ignored file (should NOT appear in diff)
		await writeFile(
			join(gitTestDir, "ignored.txt"),
			"This should not appear\n",
		);
		await writeFile(join(gitTestDir, "debug.log"), "Log file - ignored\n");

		// Create app with git test directory
		const result = createApp({
			agentCommand: "true",
			agentArgs: [],
			agentCwd: gitTestDir,
			enableLogging: false,
		});
		app = result.app;
	});

	after(async () => {
		await rm(gitTestDir, { recursive: true, force: true });
	});

	describe("GET /diff - Full diff with patches", () => {
		it("returns all changed files with correct statuses", async () => {
			const res = await app.request("/diff");
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffResponse;

			// Should have 4 changed files: modified, deleted, new-file, src/new-component
			assert.equal(
				body.stats.filesChanged,
				4,
				`Expected 4 changed files, got ${body.stats.filesChanged}. Files: ${body.files.map((f) => `${f.path}:${f.status}`).join(", ")}`,
			);

			// Find each file by path
			const modified = body.files.find((f) => f.path === "modified.txt");
			const deleted = body.files.find((f) => f.path === "deleted.txt");
			const newFile = body.files.find((f) => f.path === "new-file.txt");
			const newComponent = body.files.find(
				(f) => f.path === "src/new-component.ts",
			);

			// Verify modified file
			assert.ok(modified, "Should include modified.txt");
			assert.equal(
				modified.status,
				"modified",
				"modified.txt should be modified",
			);
			assert.ok(modified.additions > 0, "Modified file should have additions");
			assert.ok(modified.deletions > 0, "Modified file should have deletions");
			assert.ok(modified.patch, "Modified file should have patch");

			// Verify deleted file
			assert.ok(deleted, "Should include deleted.txt");
			assert.equal(deleted.status, "deleted", "deleted.txt should be deleted");
			assert.ok(deleted.deletions > 0, "Deleted file should have deletions");
			assert.ok(deleted.patch, "Deleted file should have patch");

			// Verify new untracked file
			assert.ok(newFile, "Should include new-file.txt");
			assert.equal(newFile.status, "added", "new-file.txt should be added");
			assert.ok(newFile.additions > 0, "New file should have additions");
			assert.equal(newFile.deletions, 0, "New file should have no deletions");
			assert.ok(newFile.patch, "New file should have patch");

			// Verify new file in subdirectory
			assert.ok(newComponent, "Should include src/new-component.ts");
			assert.equal(
				newComponent.status,
				"added",
				"src/new-component.ts should be added",
			);

			// Verify ignored files are NOT included
			const ignored = body.files.find((f) => f.path === "ignored.txt");
			const logFile = body.files.find((f) => f.path === "debug.log");
			assert.ok(!ignored, "Should NOT include ignored.txt");
			assert.ok(!logFile, "Should NOT include debug.log");

			// Verify unchanged files are NOT included
			const unchanged = body.files.find((f) => f.path === "unchanged.txt");
			assert.ok(!unchanged, "Should NOT include unchanged.txt");
		});

		it("calculates stats correctly", async () => {
			const res = await app.request("/diff");
			const body = (await res.json()) as DiffResponse;

			// Stats should match sum of individual files
			const totalAdditions = body.files.reduce(
				(sum, f) => sum + f.additions,
				0,
			);
			const totalDeletions = body.files.reduce(
				(sum, f) => sum + f.deletions,
				0,
			);

			assert.equal(body.stats.additions, totalAdditions);
			assert.equal(body.stats.deletions, totalDeletions);
			assert.equal(body.stats.filesChanged, body.files.length);
		});
	});

	describe("GET /diff?format=files - File list with status", () => {
		it("returns file entries with status (not just paths)", async () => {
			const res = await app.request("/diff?format=files");
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffFilesResponse;

			// Files should be objects with path and status, not just strings
			assert.ok(Array.isArray(body.files), "Should have files array");
			assert.equal(body.files.length, 4, "Should have 4 changed files");

			// Each file should have path and status
			for (const file of body.files) {
				assert.ok(
					typeof file === "object",
					"File entry should be an object, not a string",
				);
				assert.ok(
					typeof (file as DiffFileEntry).path === "string",
					"File entry should have path",
				);
				assert.ok(
					typeof (file as DiffFileEntry).status === "string",
					"File entry should have status",
				);
				assert.ok(
					["added", "modified", "deleted", "renamed"].includes(
						(file as DiffFileEntry).status,
					),
					`Status should be valid, got: ${(file as DiffFileEntry).status}`,
				);
			}

			// Verify specific statuses
			const files = body.files as DiffFileEntry[];
			const modified = files.find((f) => f.path === "modified.txt");
			const deleted = files.find((f) => f.path === "deleted.txt");
			const newFile = files.find((f) => f.path === "new-file.txt");

			assert.ok(modified, "Should include modified.txt");
			assert.equal(modified.status, "modified");

			assert.ok(deleted, "Should include deleted.txt");
			assert.equal(deleted.status, "deleted");

			assert.ok(newFile, "Should include new-file.txt");
			assert.equal(newFile.status, "added");
		});

		it("includes stats", async () => {
			const res = await app.request("/diff?format=files");
			const body = (await res.json()) as DiffFilesResponse;

			assert.ok(body.stats, "Should have stats");
			assert.equal(body.stats.filesChanged, 4);
			assert.ok(body.stats.additions > 0);
			assert.ok(body.stats.deletions > 0);
		});
	});

	describe("GET /diff?path=<file> - Single file diff", () => {
		it("returns diff for modified file", async () => {
			const res = await app.request("/diff?path=modified.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;
			assert.equal(body.path, "modified.txt");
			assert.equal(body.status, "modified");
			assert.ok(body.additions > 0);
			assert.ok(body.deletions > 0);
			assert.ok(body.patch.length > 0);
		});

		it("returns diff for deleted file", async () => {
			const res = await app.request("/diff?path=deleted.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;
			assert.equal(body.path, "deleted.txt");
			assert.equal(body.status, "deleted");
			assert.ok(body.deletions > 0);
			assert.ok(body.patch.length > 0);
		});

		it("returns diff for new untracked file", async () => {
			const res = await app.request("/diff?path=new-file.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;
			assert.equal(body.path, "new-file.txt");
			assert.equal(body.status, "added");
			assert.ok(body.additions > 0);
			assert.equal(body.deletions, 0);
			assert.ok(body.patch.length > 0);
		});

		it("returns patch with actual file content for untracked file", async () => {
			const res = await app.request("/diff?path=new-file.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;

			// Patch should contain the file content as additions
			assert.ok(
				body.patch.includes("+This is a new file"),
				`Patch should contain file content. Got: ${body.patch}`,
			);
			// Patch should have proper unified diff format
			assert.ok(
				body.patch.includes("diff --git"),
				"Patch should have diff header",
			);
			assert.ok(
				body.patch.includes("new file mode"),
				"Patch should indicate new file",
			);
			assert.ok(
				body.patch.includes("--- /dev/null"),
				"Patch should show /dev/null as old file",
			);
			assert.ok(
				body.patch.includes("+++ b/new-file.txt"),
				"Patch should show new file path",
			);
			assert.ok(body.patch.includes("@@"), "Patch should have hunk header");
		});

		it("returns unchanged status for unmodified file", async () => {
			const res = await app.request("/diff?path=unchanged.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;
			assert.equal(body.path, "unchanged.txt");
			assert.equal(body.status, "unchanged");
			assert.equal(body.additions, 0);
			assert.equal(body.deletions, 0);
		});

		it("returns unchanged status for non-existent file", async () => {
			const res = await app.request("/diff?path=does-not-exist.txt");
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;
			assert.equal(body.status, "unchanged");
		});
	});
});

// =============================================================================
// Git Diff with baseCommit Tests
// =============================================================================

describe("Git Diff API - baseCommit parameter", () => {
	const gitTestDir = "/tmp/agent-api-basecommit-test";
	let app: ReturnType<typeof createApp>["app"];
	let firstCommitSha: string;
	let secondCommitSha: string;

	before(async () => {
		// Clean up any existing test directory
		await rm(gitTestDir, { recursive: true, force: true });

		// Create test directory
		await mkdir(gitTestDir, { recursive: true });

		// Initialize git repo
		await execAsync("git init", { cwd: gitTestDir });
		await execAsync('git config user.email "test@test.com"', {
			cwd: gitTestDir,
		});
		await execAsync('git config user.name "Test User"', { cwd: gitTestDir });

		// Create initial commit
		await writeFile(join(gitTestDir, "file1.txt"), "Initial content\n");
		await writeFile(join(gitTestDir, "file2.txt"), "File 2 content\n");
		await execAsync("git add .", { cwd: gitTestDir });
		await execAsync('git commit -m "Initial commit"', { cwd: gitTestDir });

		// Get first commit SHA
		const { stdout: sha1 } = await execAsync("git rev-parse HEAD", {
			cwd: gitTestDir,
		});
		firstCommitSha = sha1.trim();

		// Make second commit
		await writeFile(
			join(gitTestDir, "file1.txt"),
			"Modified in second commit\n",
		);
		await writeFile(
			join(gitTestDir, "file3.txt"),
			"New file in second commit\n",
		);
		await execAsync("git add .", { cwd: gitTestDir });
		await execAsync('git commit -m "Second commit"', { cwd: gitTestDir });

		// Get second commit SHA
		const { stdout: sha2 } = await execAsync("git rev-parse HEAD", {
			cwd: gitTestDir,
		});
		secondCommitSha = sha2.trim();

		// Make uncommitted changes (these will show as working tree changes)
		await writeFile(
			join(gitTestDir, "file1.txt"),
			"Uncommitted working tree changes\n",
		);
		await writeFile(join(gitTestDir, "file4.txt"), "New uncommitted file\n");

		// Create app with git test directory
		const result = createApp({
			agentCommand: "true",
			agentArgs: [],
			agentCwd: gitTestDir,
			enableLogging: false,
		});
		app = result.app;
	});

	after(async () => {
		await rm(gitTestDir, { recursive: true, force: true });
	});

	describe("GET /diff?baseCommit=<sha> - Diff against specific commit", () => {
		it("diffs against HEAD when no baseCommit is provided", async () => {
			const res = await app.request("/diff");
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffResponse;

			// Should only show uncommitted changes (file1 modified, file4 new)
			assert.equal(
				body.stats.filesChanged,
				2,
				`Expected 2 changed files (uncommitted changes only), got ${body.stats.filesChanged}. Files: ${body.files.map((f) => `${f.path}:${f.status}`).join(", ")}`,
			);

			const file1 = body.files.find((f) => f.path === "file1.txt");
			const file4 = body.files.find((f) => f.path === "file4.txt");

			assert.ok(file1, "Should include file1.txt (modified in working tree)");
			assert.equal(file1.status, "modified");

			assert.ok(file4, "Should include file4.txt (new untracked)");
			assert.equal(file4.status, "added");

			// file3 should NOT be included (no changes since HEAD)
			const file3 = body.files.find((f) => f.path === "file3.txt");
			assert.ok(!file3, "file3.txt should not appear (unchanged since HEAD)");
		});

		it("diffs against first commit showing all changes since then", async () => {
			const res = await app.request(`/diff?baseCommit=${firstCommitSha}`);
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffResponse;

			// Should show all changes since first commit:
			// - file1.txt modified (both second commit and working tree)
			// - file3.txt added (second commit)
			// - file4.txt added (working tree, untracked)
			assert.equal(
				body.stats.filesChanged,
				3,
				`Expected 3 changed files since first commit, got ${body.stats.filesChanged}. Files: ${body.files.map((f) => `${f.path}:${f.status}`).join(", ")}`,
			);

			const file1 = body.files.find((f) => f.path === "file1.txt");
			const file3 = body.files.find((f) => f.path === "file3.txt");
			const file4 = body.files.find((f) => f.path === "file4.txt");

			assert.ok(file1, "Should include file1.txt");
			assert.equal(file1.status, "modified");

			assert.ok(file3, "Should include file3.txt (added in second commit)");
			assert.equal(file3.status, "added");

			assert.ok(file4, "Should include file4.txt (new untracked)");
			assert.equal(file4.status, "added");
		});

		it("diffs against second commit showing only working tree changes", async () => {
			const res = await app.request(`/diff?baseCommit=${secondCommitSha}`);
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffResponse;

			// Same as HEAD (second commit IS HEAD), should only show uncommitted changes
			assert.equal(
				body.stats.filesChanged,
				2,
				`Expected 2 changed files since second commit, got ${body.stats.filesChanged}. Files: ${body.files.map((f) => `${f.path}:${f.status}`).join(", ")}`,
			);

			const file1 = body.files.find((f) => f.path === "file1.txt");
			const file4 = body.files.find((f) => f.path === "file4.txt");

			assert.ok(file1, "Should include file1.txt (modified in working tree)");
			assert.ok(file4, "Should include file4.txt (new untracked)");
		});

		it("works with format=files and baseCommit", async () => {
			const res = await app.request(
				`/diff?format=files&baseCommit=${firstCommitSha}`,
			);
			assert.equal(res.status, 200);

			const body = (await res.json()) as DiffFilesResponse;

			assert.ok(Array.isArray(body.files), "Should have files array");
			assert.equal(body.files.length, 3, "Should have 3 changed files");

			// Verify file entries have proper structure
			for (const file of body.files) {
				assert.ok(
					typeof (file as DiffFileEntry).path === "string",
					"Should have path",
				);
				assert.ok(
					typeof (file as DiffFileEntry).status === "string",
					"Should have status",
				);
			}
		});

		it("works with single file path and baseCommit", async () => {
			const res = await app.request(
				`/diff?path=file3.txt&baseCommit=${firstCommitSha}`,
			);
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;

			// file3.txt was added in second commit, so against first commit it shows as added
			assert.equal(body.path, "file3.txt");
			assert.equal(body.status, "added");
			assert.ok(body.additions > 0, "Should have additions");
			assert.ok(body.patch.length > 0, "Should have patch content");
		});

		it("returns unchanged for file not changed since baseCommit", async () => {
			const res = await app.request(
				`/diff?path=file2.txt&baseCommit=${firstCommitSha}`,
			);
			assert.equal(res.status, 200);

			const body = (await res.json()) as SingleFileDiffResponse;

			// file2.txt hasn't changed since initial commit
			assert.equal(body.path, "file2.txt");
			assert.equal(body.status, "unchanged");
			assert.equal(body.additions, 0);
			assert.equal(body.deletions, 0);
		});
	});
});
