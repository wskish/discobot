/**
 * File Hook Manager
 *
 * Orchestrates file hook evaluation at the end of each LLM turn using a
 * pending-hook tracking model:
 *
 * 1. run agent.prompt()
 * 2. find changed files since marker
 * 3. evaluate which hooks need to run → mark as pending
 * 4. touch marker (always advance)
 * 5. run all hooks marked pending, stop on first failure
 * 6. if failed → form user message, go to step 1
 *
 * Pending hooks persist in status.json across turns, ensuring that hooks
 * blocked by earlier failures are still executed once the blocker is resolved.
 *
 * Also handles pre-commit hook installation on startup.
 */

import { exec } from "node:child_process";
import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import picomatch from "picomatch";
import {
	type ExecuteHookOptions,
	executeHook,
	getHookOutputPath,
	type HookResult,
} from "./executor.js";
import { discoverHooks, HOOKS_DIR, type Hook } from "./parser.js";
import { installPreCommitHook } from "./pre-commit.js";
import {
	addPendingHooks,
	getHooksDataDir,
	getLastEvalMarkerPath,
	getPendingHookIds,
	type HookStatusFile,
	loadStatus,
	removePendingHook,
	setHookRunning,
	updateHookStatus,
	updateLastEvaluatedAt,
} from "./status.js";

const execAsync = promisify(exec);

/** Inline output threshold: include output inline if under this size */
const INLINE_OUTPUT_MAX_LINES = 200;
const INLINE_OUTPUT_MAX_BYTES = 5 * 1024; // 5KB

/**
 * Result of evaluating file hooks after an LLM turn
 */
export interface FileHookEvalResult {
	/** Whether any hooks were evaluated */
	evaluated: boolean;
	/** Whether a hook failed and the LLM should be re-prompted */
	shouldReprompt: boolean;
	/** Formatted message for the LLM (only if shouldReprompt is true) */
	llmMessage: string | null;
	/** The hook that failed (if any) */
	failedResult: HookResult | null;
}

/**
 * Manages hook lifecycle for a workspace.
 */
export class HookManager {
	private fileHooks: Hook[] = [];
	private preCommitHooks: Hook[] = [];
	private sessionId: string;
	private workspaceRoot: string;
	private hooksDataDir: string;
	private initialized = false;

	constructor(workspaceRoot: string, sessionId: string) {
		this.workspaceRoot = workspaceRoot;
		this.sessionId = sessionId;
		this.hooksDataDir = getHooksDataDir(sessionId);
	}

	/**
	 * Initialize the hook manager: discover hooks, install git hooks.
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		const hooksDir = join(this.workspaceRoot, HOOKS_DIR);
		const allHooks = await discoverHooks(hooksDir);

		this.fileHooks = allHooks.filter((h) => h.type === "file");
		this.preCommitHooks = allHooks.filter((h) => h.type === "pre-commit");

		if (this.fileHooks.length > 0) {
			console.log(
				`[hooks] Discovered ${this.fileHooks.length} file hook(s): ${this.fileHooks.map((h) => h.name).join(", ")}`,
			);
		}

		if (this.preCommitHooks.length > 0) {
			console.log(
				`[hooks] Discovered ${this.preCommitHooks.length} pre-commit hook(s): ${this.preCommitHooks.map((h) => h.name).join(", ")}`,
			);
			await installPreCommitHook(
				this.workspaceRoot,
				this.preCommitHooks,
				this.sessionId,
			);
		}

		this.initialized = true;
	}

	/**
	 * Reload hooks from disk: re-discover all hooks and re-install pre-commit hooks.
	 */
	private async reloadHooks(): Promise<void> {
		const hooksDir = join(this.workspaceRoot, HOOKS_DIR);
		const allHooks = await discoverHooks(hooksDir);

		this.fileHooks = allHooks.filter((h) => h.type === "file");
		this.preCommitHooks = allHooks.filter((h) => h.type === "pre-commit");

		console.log(
			`[hooks] Reloaded hooks: ${this.fileHooks.length} file, ${this.preCommitHooks.length} pre-commit`,
		);

		if (this.preCommitHooks.length > 0) {
			await installPreCommitHook(
				this.workspaceRoot,
				this.preCommitHooks,
				this.sessionId,
			);
		}
	}

	/**
	 * Check if any file in .discobot/hooks/ has changed since the last
	 * evaluation marker, and reload hooks if so.
	 *
	 * Checks both the directory mtime (detects file add/remove) and
	 * individual file mtimes (detects content edits).
	 */
	private async checkAndReloadHooks(): Promise<void> {
		const hooksDir = join(this.workspaceRoot, HOOKS_DIR);
		const markerPath = getLastEvalMarkerPath(this.hooksDataDir);

		let markerMtime: number | null = null;
		try {
			const markerStat = await stat(markerPath);
			markerMtime = markerStat.mtimeMs;
		} catch {
			// No marker — first evaluation, hooks were just loaded in init()
			return;
		}

		try {
			// Check directory mtime (catches file additions/removals)
			const dirStat = await stat(hooksDir);
			if (dirStat.mtimeMs > markerMtime) {
				await this.reloadHooks();
				return;
			}

			// Check individual file mtimes (catches content edits)
			const entries = await readdir(hooksDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() || entry.name.startsWith(".")) continue;
				const filePath = join(hooksDir, entry.name);
				const fileStat = await stat(filePath);
				if (fileStat.mtimeMs > markerMtime) {
					await this.reloadHooks();
					return;
				}
			}
		} catch {
			// Directory doesn't exist or can't be read — nothing to reload
		}
	}

	/**
	 * Check if there are any file hooks to evaluate.
	 */
	hasFileHooks(): boolean {
		return this.fileHooks.length > 0;
	}

	/**
	 * Get the current hook status (for API endpoint).
	 */
	async getStatus(): Promise<HookStatusFile> {
		return loadStatus(this.hooksDataDir);
	}

	/**
	 * Get the output log content for a specific hook.
	 * Returns null if the log file doesn't exist.
	 */
	async getHookOutput(hookId: string): Promise<string | null> {
		const outputPath = getHookOutputPath(this.hooksDataDir, hookId);
		try {
			const { readFile } = await import("node:fs/promises");
			return await readFile(outputPath, "utf-8");
		} catch {
			return null;
		}
	}

	/**
	 * Manually rerun a specific hook by ID.
	 * Runs against current dirty files and updates status.
	 * Returns null if the hook is not found.
	 */
	async rerunHook(hookId: string): Promise<HookResult | null> {
		const hook = this.fileHooks.find((h) => h.id === hookId);
		if (!hook || !hook.pattern) return null;

		const allDirtyFiles = await this.getAllDirtyFiles();
		const matcher = picomatch(hook.pattern, { dot: false });
		const matchingFiles = allDirtyFiles.filter((file) => matcher(file));

		const outputPath = getHookOutputPath(this.hooksDataDir, hook.id);
		const opts: ExecuteHookOptions = {
			cwd: this.workspaceRoot,
			changedFiles: matchingFiles.length > 0 ? matchingFiles : undefined,
			sessionId: this.sessionId,
			outputPath,
		};

		console.log(
			`[hooks] Manual rerun "${hook.name}" on ${matchingFiles.length} dirty file(s)`,
		);

		await setHookRunning(this.hooksDataDir, hook);
		const result = await executeHook(hook, opts);
		await updateHookStatus(this.hooksDataDir, result, outputPath);

		if (result.success) {
			await removePendingHook(this.hooksDataDir, hook.id);
		}

		await updateLastEvaluatedAt(this.hooksDataDir);
		return result;
	}

	/**
	 * Evaluate file hooks after an LLM turn.
	 *
	 * Uses a pending-hook model to track obligations across turns:
	 *   Step 2: Find files changed since marker
	 *   Step 3: Mark matching hooks as pending
	 *   Step 4: Touch marker (always advance)
	 *   Step 5: Run all pending hooks using current dirty files, stop on first failure
	 *   Step 6: If failed, return re-prompt message
	 *
	 * @returns Evaluation result indicating whether to re-prompt the LLM
	 */
	async evaluateFileHooks(): Promise<FileHookEvalResult> {
		const noAction: FileHookEvalResult = {
			evaluated: false,
			shouldReprompt: false,
			llmMessage: null,
			failedResult: null,
		};

		// Reload hooks if any file in .discobot/hooks/ changed since last eval
		await this.checkAndReloadHooks();

		if (this.fileHooks.length === 0) {
			return noAction;
		}

		// Step 2-3: Detect new changes since marker, mark matching hooks as pending
		const newFiles = await this.findChangedFilesSinceMarker();
		let addedNewPending = false;
		if (newFiles.length > 0) {
			console.log(
				`[hooks] Files changed since last eval: ${newFiles.join(", ")}`,
			);
			const matches = this.matchHooksToFiles(newFiles);
			if (matches.length > 0) {
				const newPendingIds = matches.map((m) => m.hook.id);
				await addPendingHooks(this.hooksDataDir, newPendingIds);
				addedNewPending = true;
				console.log(
					`[hooks] Marked ${newPendingIds.length} hook(s) as pending: ${newPendingIds.join(", ")}`,
				);
			}
		}

		// Step 4: Always advance marker
		await this.touchMarker();

		// Step 5: Run all pending hooks
		const pendingIds = await getPendingHookIds(this.hooksDataDir);
		if (pendingIds.length === 0) {
			return noAction;
		}

		// If no files changed since last eval and we didn't add new pending hooks,
		// skip re-running — the hooks would produce the same result. Leave them
		// in their failed state until a file change triggers re-evaluation.
		if (newFiles.length === 0 && !addedNewPending) {
			console.log(
				`[hooks] Skipping re-evaluation (no files changed since last eval)`,
			);
			return noAction;
		}

		const pendingSet = new Set(pendingIds);
		const allDirtyFiles = await this.getAllDirtyFiles();

		console.log(
			`[hooks] Running ${pendingIds.length} pending hook(s), ${allDirtyFiles.length} dirty file(s)`,
		);

		for (const hook of this.fileHooks) {
			if (!pendingSet.has(hook.id)) continue;
			if (!hook.pattern) continue;

			// Match against current dirty files
			const matcher = picomatch(hook.pattern, { dot: false });
			const matchingFiles = allDirtyFiles.filter((file) => matcher(file));

			if (matchingFiles.length === 0) {
				// Files were fixed/committed — clear pending without running
				await removePendingHook(this.hooksDataDir, hook.id);
				console.log(
					`[hooks] Hook "${hook.name}" cleared (no matching dirty files)`,
				);
				continue;
			}

			const outputPath = getHookOutputPath(this.hooksDataDir, hook.id);
			const opts: ExecuteHookOptions = {
				cwd: this.workspaceRoot,
				changedFiles: matchingFiles,
				sessionId: this.sessionId,
				outputPath,
			};

			console.log(
				`[hooks] Running "${hook.name}" (pattern: ${hook.pattern}) on ${matchingFiles.length} file(s)`,
			);

			await setHookRunning(this.hooksDataDir, hook);
			const result = await executeHook(hook, opts);
			await updateHookStatus(this.hooksDataDir, result, outputPath);

			if (result.success) {
				await removePendingHook(this.hooksDataDir, hook.id);
				console.log(
					`[hooks] Hook "${hook.name}" passed (${result.durationMs}ms)`,
				);
				continue;
			}

			// Hook failed
			console.log(
				`[hooks] Hook "${hook.name}" failed (exit ${result.exitCode}, ${result.durationMs}ms)`,
			);

			if (hook.notifyLlm) {
				const llmMessage = formatHookFailureMessage(
					result,
					matchingFiles,
					outputPath,
				);

				return {
					evaluated: true,
					shouldReprompt: true,
					llmMessage,
					failedResult: result,
				};
			}

			// Hook failed but don't notify LLM — stop processing more hooks
			return {
				evaluated: true,
				shouldReprompt: false,
				llmMessage: null,
				failedResult: result,
			};
		}

		// All pending hooks cleared
		return {
			evaluated: true,
			shouldReprompt: false,
			llmMessage: null,
			failedResult: null,
		};
	}

	/**
	 * Get all dirty files in the workspace (staged, unstaged, untracked).
	 * No marker filtering — returns the full set of uncommitted changes.
	 */
	private async getAllDirtyFiles(): Promise<string[]> {
		try {
			const [diffResult, untrackedResult] = await Promise.all([
				execAsync("git diff --name-only HEAD 2>/dev/null || true", {
					cwd: this.workspaceRoot,
				}),
				execAsync(
					"git ls-files --others --exclude-standard 2>/dev/null || true",
					{ cwd: this.workspaceRoot },
				),
			]);

			const allFiles = new Set<string>();

			for (const line of diffResult.stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) allFiles.add(trimmed);
			}
			for (const line of untrackedResult.stdout.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) allFiles.add(trimmed);
			}

			return Array.from(allFiles);
		} catch (err) {
			console.error("[hooks] Failed to detect dirty files:", err);
			return [];
		}
	}

	/**
	 * Find files changed since the last evaluation marker.
	 *
	 * Gets all dirty files from git, then filters to only those with
	 * mtime > marker mtime. On first evaluation (no marker), returns all dirty files.
	 */
	private async findChangedFilesSinceMarker(): Promise<string[]> {
		const markerPath = getLastEvalMarkerPath(this.hooksDataDir);
		let markerMtime: number | null = null;

		try {
			const markerStat = await stat(markerPath);
			markerMtime = markerStat.mtimeMs;
		} catch {
			// No marker — first evaluation
		}

		const allFiles = await this.getAllDirtyFiles();
		if (allFiles.length === 0) {
			return [];
		}

		// If no marker, all dirty files count as "changed"
		if (markerMtime === null) {
			return allFiles;
		}

		// Filter to files modified after the marker
		const recentFiles: string[] = [];
		for (const relPath of allFiles) {
			try {
				const absPath = join(this.workspaceRoot, relPath);
				const fileStat = await stat(absPath);
				if (fileStat.mtimeMs > markerMtime) {
					recentFiles.push(relPath);
				}
			} catch {
				// File might have been deleted — skip
			}
		}
		return recentFiles;
	}

	/**
	 * Match hooks to changed files based on glob patterns.
	 * Returns hooks with their matching file lists, in hook order.
	 */
	private matchHooksToFiles(
		changedFiles: string[],
	): Array<{ hook: Hook; files: string[] }> {
		const results: Array<{ hook: Hook; files: string[] }> = [];

		for (const hook of this.fileHooks) {
			if (!hook.pattern) continue;

			const matcher = picomatch(hook.pattern, { dot: false });
			const matchingFiles = changedFiles.filter((file) => {
				// Match against the relative path and also just the basename
				return matcher(file);
			});

			if (matchingFiles.length > 0) {
				results.push({ hook, files: matchingFiles });
			}
		}

		return results;
	}

	/**
	 * Touch the last-eval marker file to record current evaluation time.
	 */
	private async touchMarker(): Promise<void> {
		const markerPath = getLastEvalMarkerPath(this.hooksDataDir);
		try {
			const { mkdir } = await import("node:fs/promises");
			await mkdir(this.hooksDataDir, { recursive: true });
			// Create or update the marker file
			const now = new Date();
			try {
				await utimes(markerPath, now, now);
			} catch {
				// File doesn't exist, create it
				await writeFile(markerPath, "", "utf-8");
			}
		} catch (err) {
			console.error("[hooks] Failed to update eval marker:", err);
		}

		await updateLastEvaluatedAt(this.hooksDataDir);
	}
}

/**
 * Format a hook failure message for the LLM.
 *
 * Uses XML tags so the UI can parse and display structured hook failure info.
 * Small output (≤ 200 lines / 5KB) is included inline.
 * Large output references the log file path.
 */
function formatHookFailureMessage(
	result: HookResult,
	changedFiles: string[],
	outputPath: string,
): string {
	const lines: string[] = [];

	lines.push("<hook-failure>");
	lines.push(`<hook-name>${result.hook.name}</hook-name>`);
	lines.push(`<pattern>${result.hook.pattern}</pattern>`);
	lines.push(`<exit-code>${result.exitCode}</exit-code>`);

	// List affected files
	const fileList = changedFiles.slice(0, 20).join(", ");
	const moreFiles =
		changedFiles.length > 20 ? `, and ${changedFiles.length - 20} more` : "";
	lines.push(`<files>${fileList}${moreFiles}</files>`);

	// Decide whether to inline or reference the output
	const output = result.output.trim();
	const outputLineCount = output.split("\n").length;
	const outputBytes = Buffer.byteLength(output, "utf-8");

	if (
		outputBytes <= INLINE_OUTPUT_MAX_BYTES &&
		outputLineCount <= INLINE_OUTPUT_MAX_LINES
	) {
		lines.push(`<output>\n${output}\n</output>`);
	} else {
		lines.push(`<output-path>${outputPath}</output-path>`);
	}

	lines.push("</hook-failure>");
	lines.push("");
	lines.push("Please fix the issues above and ensure the hook passes.");

	return lines.join("\n");
}
