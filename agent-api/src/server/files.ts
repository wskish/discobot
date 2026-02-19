/**
 * File System Operations
 *
 * This module provides file system operations for the agent API.
 * All operations are scoped to the workspace root to prevent directory traversal.
 */

import { exec } from "node:child_process";
import {
	access,
	readFile as fsReadFile,
	rename as fsRename,
	writeFile as fsWriteFile,
	mkdir,
	readdir,
	rm,
	stat,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	DeleteFileResponse,
	DiffFilesResponse,
	DiffResponse,
	DiffStats,
	FileDiffEntry,
	FileEntry,
	ListFilesResponse,
	ReadFileResponse,
	RenameFileResponse,
	SingleFileDiffResponse,
	WriteFileResponse,
} from "../api/types.js";

const execAsync = promisify(exec);

// Maximum file size for read operations (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Known text file extensions
const TEXT_EXTENSIONS = new Set([
	// Code
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".go",
	".rs",
	".java",
	".kt",
	".scala",
	".c",
	".cpp",
	".h",
	".hpp",
	".cs",
	".swift",
	".php",
	".lua",
	".pl",
	".sh",
	".bash",
	".zsh",
	// Config
	".json",
	".yaml",
	".yml",
	".toml",
	".xml",
	".ini",
	".env",
	".gitignore",
	".editorconfig",
	".prettierrc",
	".eslintrc",
	".dockerignore",
	".npmrc",
	".nvmrc",
	// Markup
	".md",
	".mdx",
	".html",
	".htm",
	".css",
	".scss",
	".less",
	".svg",
	".vue",
	".svelte",
	".astro",
	// Data
	".txt",
	".csv",
	".log",
	".sql",
	// Special
	".lock",
	".sum",
	".mod",
]);

// Known binary file extensions
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".bmp",
	".tiff",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".pdf",
	".zip",
	".tar",
	".gz",
	".bz2",
	".xz",
	".7z",
	".rar",
	".exe",
	".dll",
	".so",
	".dylib",
	".a",
	".wasm",
	".node",
	".mp3",
	".mp4",
	".wav",
	".ogg",
	".webm",
	".avi",
	".mov",
	".db",
	".sqlite",
	".sqlite3",
]);

// ============================================================================
// Error Types
// ============================================================================

/** HTTP status codes used for file operation errors */
export type FileErrorStatus = 400 | 403 | 404 | 413 | 500;

export interface FileError {
	error: string;
	status: FileErrorStatus;
}

export type FileResult<T> = T | FileError;

export function isFileError(result: FileResult<unknown>): result is FileError {
	return (
		typeof result === "object" &&
		result !== null &&
		"error" in result &&
		"status" in result
	);
}

// ============================================================================
// Path Validation
// ============================================================================

/**
 * Validates and resolves a path relative to the workspace root.
 * Prevents directory traversal attacks.
 *
 * @param inputPath - User-provided path (relative to workspace)
 * @param workspaceRoot - Absolute path to workspace root
 * @returns Resolved absolute path or null if invalid
 */
export function validatePath(
	inputPath: string,
	workspaceRoot: string,
): string | null {
	// Normalize the input - handle empty or "." as root
	const normalizedInput =
		inputPath === "" || inputPath === "." ? "." : inputPath;

	// Reject absolute paths immediately
	if (normalizedInput.startsWith("/") || normalizedInput.startsWith("\\")) {
		return null;
	}

	// Resolve to absolute path
	const resolved = resolve(workspaceRoot, normalizedInput);

	// Get relative path from workspace root
	const rel = relative(workspaceRoot, resolved);

	// Check for traversal:
	// 1. Empty rel means it's the root itself (valid)
	// 2. Starting with ".." means it escapes the workspace
	if (rel.startsWith("..")) {
		return null;
	}

	return resolved;
}

// ============================================================================
// File Type Detection
// ============================================================================

/**
 * Determines if a file should be treated as text or binary.
 *
 * @param path - File path (used for extension detection)
 * @param content - Optional file content buffer for inspection
 * @returns true if the file is text, false if binary
 */
export function isTextFile(path: string, content?: Buffer): boolean {
	const ext = extname(path).toLowerCase();

	// Check extension-less files by name
	const baseName = path.split("/").pop() || "";
	if (
		baseName === "Makefile" ||
		baseName === "Dockerfile" ||
		baseName === "Vagrantfile" ||
		baseName === "Gemfile" ||
		baseName === "Rakefile" ||
		baseName === "LICENSE" ||
		baseName === "README" ||
		baseName === "CHANGELOG"
	) {
		return true;
	}

	if (TEXT_EXTENSIONS.has(ext)) return true;
	if (BINARY_EXTENSIONS.has(ext)) return false;

	// No extension or unknown - check content for null bytes
	if (content) {
		// Check first 8KB for null bytes
		const checkLength = Math.min(content.length, 8192);
		for (let i = 0; i < checkLength; i++) {
			if (content[i] === 0) return false;
		}
		return true;
	}

	// Default to text for unknown without content check
	return true;
}

// ============================================================================
// Directory Listing
// ============================================================================

export interface ListOptions {
	workspaceRoot: string;
	includeHidden?: boolean;
}

/**
 * Lists the contents of a directory.
 *
 * @param path - Path relative to workspace root
 * @param options - List options including workspace root
 * @returns Directory listing or error
 */
export async function listDirectory(
	path: string,
	options: ListOptions,
): Promise<FileResult<ListFilesResponse>> {
	const resolved = validatePath(path, options.workspaceRoot);
	if (!resolved) {
		return { error: "Invalid path", status: 400 };
	}

	try {
		const stats = await stat(resolved);
		if (!stats.isDirectory()) {
			return { error: "Not a directory", status: 400 };
		}

		const dirents = await readdir(resolved, { withFileTypes: true });
		const entries: FileEntry[] = [];

		for (const dirent of dirents) {
			// Skip hidden files unless requested
			if (!options.includeHidden && dirent.name.startsWith(".")) {
				continue;
			}

			const entry: FileEntry = {
				name: dirent.name,
				type: dirent.isDirectory() ? "directory" : "file",
			};

			if (!dirent.isDirectory()) {
				try {
					const fileStat = await stat(join(resolved, dirent.name));
					entry.size = fileStat.size;
				} catch {
					// Ignore stat errors for individual files
				}
			}

			entries.push(entry);
		}

		// Sort: directories first, then alphabetically
		entries.sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === "directory" ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});

		// Return relative path for consistency
		const relativePath = relative(options.workspaceRoot, resolved) || ".";
		return { path: relativePath, entries };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: "Directory not found", status: 404 };
		}
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			return { error: "Permission denied", status: 403 };
		}
		throw err;
	}
}

// ============================================================================
// File Reading
// ============================================================================

export interface ReadOptions {
	workspaceRoot: string;
	maxSize?: number;
}

/**
 * Reads the content of a file.
 *
 * @param path - Path relative to workspace root
 * @param options - Read options including workspace root
 * @returns File content or error
 */
export async function readFile(
	path: string,
	options: ReadOptions,
): Promise<FileResult<ReadFileResponse>> {
	const resolved = validatePath(path, options.workspaceRoot);
	if (!resolved) {
		return { error: "Invalid path", status: 400 };
	}

	const maxSize = options.maxSize ?? MAX_FILE_SIZE;

	try {
		const stats = await stat(resolved);

		if (stats.isDirectory()) {
			return { error: "Is a directory", status: 400 };
		}

		if (stats.size > maxSize) {
			return { error: "File too large", status: 413 };
		}

		const content = await fsReadFile(resolved);
		const isText = isTextFile(path, content);
		const relativePath = relative(options.workspaceRoot, resolved);

		return {
			path: relativePath,
			content: isText ? content.toString("utf8") : content.toString("base64"),
			encoding: isText ? "utf8" : "base64",
			size: stats.size,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: "File not found", status: 404 };
		}
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			return { error: "Permission denied", status: 403 };
		}
		throw err;
	}
}

// ============================================================================
// File Writing
// ============================================================================

export interface WriteOptions {
	workspaceRoot: string;
}

/**
 * Writes content to a file.
 *
 * @param path - Path relative to workspace root
 * @param content - Content to write
 * @param encoding - Content encoding (utf8 or base64)
 * @param options - Write options including workspace root
 * @returns Write result or error
 */
export async function writeFile(
	path: string,
	content: string,
	encoding: "utf8" | "base64" = "utf8",
	options: WriteOptions,
): Promise<FileResult<WriteFileResponse>> {
	const resolved = validatePath(path, options.workspaceRoot);
	if (!resolved) {
		return { error: "Invalid path", status: 400 };
	}

	try {
		// Ensure parent directory exists
		await mkdir(dirname(resolved), { recursive: true });

		const buffer =
			encoding === "base64"
				? Buffer.from(content, "base64")
				: Buffer.from(content, "utf8");

		await fsWriteFile(resolved, buffer);

		const relativePath = relative(options.workspaceRoot, resolved);
		return {
			path: relativePath,
			size: buffer.length,
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			return { error: "Permission denied", status: 403 };
		}
		throw err;
	}
}

// ============================================================================
// File Deletion
// ============================================================================

export interface DeleteOptions {
	workspaceRoot: string;
}

/**
 * Deletes a file or directory.
 *
 * @param path - Path relative to workspace root
 * @param options - Delete options including workspace root
 * @returns Delete result or error
 */
export async function deleteFile(
	path: string,
	options: DeleteOptions,
): Promise<FileResult<DeleteFileResponse>> {
	const resolved = validatePath(path, options.workspaceRoot);
	if (!resolved) {
		return { error: "Invalid path", status: 400 };
	}

	// Prevent deleting the workspace root
	if (resolved === options.workspaceRoot) {
		return { error: "Cannot delete workspace root", status: 400 };
	}

	try {
		const stats = await stat(resolved);
		const type = stats.isDirectory() ? "directory" : "file";

		await rm(resolved, { recursive: true });

		const relativePath = relative(options.workspaceRoot, resolved);
		return { path: relativePath, type };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: "File not found", status: 404 };
		}
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			return { error: "Permission denied", status: 403 };
		}
		throw err;
	}
}

// ============================================================================
// File Renaming
// ============================================================================

export interface RenameOptions {
	workspaceRoot: string;
}

/**
 * Renames (moves) a file or directory.
 *
 * @param oldPath - Current path relative to workspace root
 * @param newPath - New path relative to workspace root
 * @param options - Rename options including workspace root
 * @returns Rename result or error
 */
export async function renameFile(
	oldPath: string,
	newPath: string,
	options: RenameOptions,
): Promise<FileResult<RenameFileResponse>> {
	const resolvedOld = validatePath(oldPath, options.workspaceRoot);
	if (!resolvedOld) {
		return { error: "Invalid source path", status: 400 };
	}

	const resolvedNew = validatePath(newPath, options.workspaceRoot);
	if (!resolvedNew) {
		return { error: "Invalid destination path", status: 400 };
	}

	try {
		// Verify source exists
		await stat(resolvedOld);

		// Ensure parent directory of destination exists
		await mkdir(dirname(resolvedNew), { recursive: true });

		await fsRename(resolvedOld, resolvedNew);

		const relativeOld = relative(options.workspaceRoot, resolvedOld);
		const relativeNew = relative(options.workspaceRoot, resolvedNew);
		return { oldPath: relativeOld, newPath: relativeNew };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { error: "File not found", status: 404 };
		}
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			return { error: "Permission denied", status: 403 };
		}
		throw err;
	}
}

// ============================================================================
// Diff Operations
// ============================================================================

/**
 * Check if directory is a git repository
 */
async function isGitRepo(dir: string): Promise<boolean> {
	try {
		await access(join(dir, ".git"));
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse unified diff output into structured response
 */
function parseDiffOutput(output: string): DiffResponse {
	const files: FileDiffEntry[] = [];
	let current: FileDiffEntry | null = null;
	let patchLines: string[] = [];

	// Patterns for parsing git diff output
	const diffHeader = /^diff --git a\/(.+) b\/(.+)$/;
	const newFileMode = /^new file mode/;
	const deletedFileMode = /^deleted file mode/;
	const renameFrom = /^rename from/;
	const binaryFiles = /^Binary files/;

	for (const line of output.split("\n")) {
		const headerMatch = line.match(diffHeader);

		if (headerMatch) {
			// Save previous diff
			if (current) {
				current.patch = patchLines.join("\n");
				files.push(current);
			}

			const oldPath = headerMatch[1];
			const newPath = headerMatch[2];

			current = {
				path: newPath || oldPath,
				oldPath: oldPath !== newPath ? oldPath : undefined,
				status: "modified",
				additions: 0,
				deletions: 0,
				binary: false,
			};
			patchLines = [line];
			continue;
		}

		if (current) {
			patchLines.push(line);

			if (newFileMode.test(line)) current.status = "added";
			else if (deletedFileMode.test(line)) current.status = "deleted";
			else if (renameFrom.test(line)) current.status = "renamed";
			else if (binaryFiles.test(line)) current.binary = true;
			else if (line.startsWith("+") && !line.startsWith("+++"))
				current.additions++;
			else if (line.startsWith("-") && !line.startsWith("---"))
				current.deletions++;
		}
	}

	// Don't forget last diff
	if (current) {
		current.patch = patchLines.join("\n");
		files.push(current);
	}

	const stats: DiffStats = {
		filesChanged: files.length,
		additions: files.reduce((sum, f) => sum + f.additions, 0),
		deletions: files.reduce((sum, f) => sum + f.deletions, 0),
	};

	return { files, stats };
}

/**
 * Get list of untracked files (new files not yet staged)
 */
async function getUntrackedFiles(workspaceRoot: string): Promise<string[]> {
	try {
		const { stdout } = await execAsync(
			"git ls-files --others --exclude-standard",
			{
				cwd: workspaceRoot,
				maxBuffer: 10 * 1024 * 1024, // 10MB
			},
		);
		return stdout
			.split("\n")
			.map((f) => f.trim())
			.filter((f) => f.length > 0);
	} catch {
		return [];
	}
}

/**
 * Check if a buffer likely contains binary content
 */
function isBinaryContent(buffer: Buffer): boolean {
	// Check for null bytes which typically indicate binary content
	for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
		if (buffer[i] === 0) {
			return true;
		}
	}
	return false;
}

/**
 * Get diff for a single untracked file (shows all lines as additions)
 */
async function getUntrackedFileDiff(
	workspaceRoot: string,
	filePath: string,
): Promise<FileDiffEntry> {
	const fullPath = join(workspaceRoot, filePath);

	try {
		// Read file as buffer first to check for binary content
		const buffer = await fsReadFile(fullPath);

		if (isBinaryContent(buffer)) {
			return {
				path: filePath,
				status: "added",
				additions: 0,
				deletions: 0,
				binary: true,
				patch: `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\nBinary file`,
			};
		}

		// Convert to string and create diff patch
		const content = buffer.toString("utf8");
		const lines = content.split("\n");
		// Handle trailing newline - don't count empty last line
		const actualLines =
			lines.length > 0 && lines[lines.length - 1] === ""
				? lines.slice(0, -1)
				: lines;
		const additions = actualLines.length;

		// Create a unified diff format patch
		const patchLines = [
			`diff --git a/${filePath} b/${filePath}`,
			"new file mode 100644",
			"--- /dev/null",
			`+++ b/${filePath}`,
			`@@ -0,0 +1,${additions} @@`,
			...actualLines.map((line: string) => `+${line}`),
		];

		return {
			path: filePath,
			status: "added",
			additions,
			deletions: 0,
			binary: false,
			patch: patchLines.join("\n"),
		};
	} catch (err) {
		// If we can't read the file, still report it as added but log the error
		console.error(`Failed to read untracked file ${filePath}:`, err);
		return {
			path: filePath,
			status: "added",
			additions: 0,
			deletions: 0,
			binary: false,
			patch: `diff --git a/${filePath} b/${filePath}\nnew file mode 100644`,
		};
	}
}

/**
 * Fetch from origin to get the latest refs
 */
async function fetchOrigin(workspaceRoot: string): Promise<void> {
	try {
		await execAsync("git fetch origin", {
			cwd: workspaceRoot,
			timeout: 60000, // 60 second timeout
		});
	} catch (err) {
		console.warn("Failed to fetch from origin:", err);
	}
}

/**
 * Get the remote tracking branch (e.g., origin/main)
 * Tries origin/HEAD first, then falls back to origin/main or origin/master
 */
async function getRemoteTrackingBranch(
	workspaceRoot: string,
): Promise<string | null> {
	// Try origin/HEAD first (points to the default branch)
	try {
		await execAsync("git rev-parse --verify origin/HEAD", {
			cwd: workspaceRoot,
		});
		return "origin/HEAD";
	} catch {
		// origin/HEAD not set
	}

	// Try origin/main
	try {
		await execAsync("git rev-parse --verify origin/main", {
			cwd: workspaceRoot,
		});
		return "origin/main";
	} catch {
		// origin/main doesn't exist
	}

	// Try origin/master
	try {
		await execAsync("git rev-parse --verify origin/master", {
			cwd: workspaceRoot,
		});
		return "origin/master";
	} catch {
		// origin/master doesn't exist
	}

	return null;
}

/**
 * Calculate merge-base between HEAD and the remote tracking branch
 */
async function getMergeBase(workspaceRoot: string): Promise<string | null> {
	const remoteBranch = await getRemoteTrackingBranch(workspaceRoot);
	if (!remoteBranch) {
		return null;
	}

	try {
		const { stdout } = await execAsync(`git merge-base HEAD ${remoteBranch}`, {
			cwd: workspaceRoot,
		});
		return stdout.trim();
	} catch (err) {
		console.warn(`Failed to find merge-base with ${remoteBranch}:`, err);
		return null;
	}
}

/**
 * Get diff using git
 * @param workspaceRoot - The workspace root directory
 * @param singlePath - Optional single file path to get diff for
 *
 * Automatically calculates the merge-base by:
 * 1. Fetching from origin to get the latest refs
 * 2. Finding the merge-base between HEAD and the remote tracking branch
 * 3. Diffing from that merge-base to the current working tree
 */
async function getGitDiff(
	workspaceRoot: string,
	singlePath?: string,
): Promise<DiffResponse> {
	// Fetch from origin to get the latest refs
	await fetchOrigin(workspaceRoot);

	// Calculate merge-base with the remote tracking branch
	const mergeBase = await getMergeBase(workspaceRoot);

	let command = "git diff --no-color";
	// If merge-base was found, diff working tree against that commit
	// Otherwise, diffs working tree against HEAD (default git diff behavior)
	if (mergeBase) {
		command += ` ${mergeBase}`;
	}
	if (singlePath) {
		command += ` -- "${singlePath}"`;
	}

	let trackedDiff: DiffResponse;
	try {
		const { stdout } = await execAsync(command, {
			cwd: workspaceRoot,
			maxBuffer: 50 * 1024 * 1024, // 50MB for large diffs
		});
		trackedDiff = parseDiffOutput(stdout);
	} catch (err: unknown) {
		// git diff returns exit code 1 when there are differences
		const execErr = err as { code?: number; stdout?: string };
		if (execErr.code === 1 && execErr.stdout) {
			trackedDiff = parseDiffOutput(execErr.stdout);
		} else {
			// No differences or other error
			trackedDiff = {
				files: [],
				stats: { filesChanged: 0, additions: 0, deletions: 0 },
			};
		}
	}

	// Also get untracked files (new files not yet staged)
	const untrackedFiles = await getUntrackedFiles(workspaceRoot);

	// Filter untracked files if we're looking for a single path
	const relevantUntracked = singlePath
		? untrackedFiles.filter((f) => f === singlePath)
		: untrackedFiles;

	// Get diff entries for untracked files
	const untrackedEntries = await Promise.all(
		relevantUntracked.map((f) => getUntrackedFileDiff(workspaceRoot, f)),
	);

	// Combine tracked and untracked files
	const allFiles = [...trackedDiff.files, ...untrackedEntries];

	// Recalculate stats
	const stats: DiffStats = {
		filesChanged: allFiles.length,
		additions: allFiles.reduce((sum, f) => sum + f.additions, 0),
		deletions: allFiles.reduce((sum, f) => sum + f.deletions, 0),
	};

	return { files: allFiles, stats };
}

export interface DiffOptions {
	path?: string;
	format?: "full" | "files";
}

/**
 * Get diff for the session.
 *
 * @param workspaceRoot - Workspace root directory
 * @param options - Diff options
 * @returns Diff result or error
 */
export async function getDiff(
	workspaceRoot: string,
	options: DiffOptions = {},
): Promise<
	FileResult<DiffResponse | DiffFilesResponse | SingleFileDiffResponse>
> {
	// Validate single file path if provided
	if (options.path) {
		const resolved = validatePath(options.path, workspaceRoot);
		if (!resolved) {
			return { error: "Invalid path", status: 400 };
		}
	}

	// Check if it's a git repo
	const isGit = await isGitRepo(workspaceRoot);

	// Get the diff (only works for git repos)
	let diff: DiffResponse;
	if (isGit) {
		diff = await getGitDiff(workspaceRoot, options.path);
	} else {
		// Not a git repo - return empty diff
		diff = {
			files: [],
			stats: { filesChanged: 0, additions: 0, deletions: 0 },
		};
	}

	// Handle single file request
	if (options.path) {
		const file = diff.files.find((f) => f.path === options.path);
		if (!file) {
			return {
				path: options.path,
				status: "unchanged",
				additions: 0,
				deletions: 0,
				binary: false,
				patch: "",
			};
		}
		return {
			path: file.path,
			status: file.status,
			oldPath: file.oldPath,
			additions: file.additions,
			deletions: file.deletions,
			binary: file.binary,
			patch: file.patch || "",
		};
	}

	// Handle format=files request - return file entries with status
	if (options.format === "files") {
		return {
			files: diff.files.map((f) => ({
				path: f.path,
				status: f.status,
				oldPath: f.oldPath,
			})),
			stats: diff.stats,
		};
	}

	return diff;
}
