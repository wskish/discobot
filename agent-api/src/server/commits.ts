/**
 * Git Commits Operations
 *
 * This module provides git commit operations for the commit workflow.
 * Used to export commits from the sandbox for application to the workspace.
 */

import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CommitsErrorResponse, CommitsResponse } from "../api/types.js";

const execAsync = promisify(exec);

// ============================================================================
// Error Types
// ============================================================================

export type CommitsResult = CommitsResponse | CommitsErrorResponse;

export function isCommitsError(
	result: CommitsResult,
): result is CommitsErrorResponse {
	return "error" in result;
}

// ============================================================================
// Git Operations
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
 * Validate that a commit SHA exists in the repository
 */
async function commitExists(
	workspaceRoot: string,
	commitSha: string,
): Promise<boolean> {
	try {
		await execAsync(`git cat-file -t "${commitSha}"`, {
			cwd: workspaceRoot,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Count commits between parent and HEAD
 */
async function countCommits(
	workspaceRoot: string,
	parent: string,
): Promise<number> {
	try {
		const { stdout } = await execAsync(
			`git rev-list --count "${parent}..HEAD"`,
			{
				cwd: workspaceRoot,
			},
		);
		return parseInt(stdout.trim(), 10);
	} catch {
		return 0;
	}
}

/**
 * Get format-patch output for commits since a parent
 *
 * Uses `git format-patch --stdout` to generate mbox-format patches
 * that preserve all commit metadata (author, date, signatures, etc.)
 *
 * @param workspaceRoot - Workspace root directory
 * @param parent - Expected parent commit SHA
 * @returns Patches or error response
 */
export async function getCommitPatches(
	workspaceRoot: string,
	parent: string,
): Promise<CommitsResult> {
	// Validate input
	if (!parent || parent.trim() === "") {
		return {
			error: "invalid_parent",
			message: "Parent commit SHA is required",
		};
	}

	// Check if it's a git repo
	const isGit = await isGitRepo(workspaceRoot);
	if (!isGit) {
		return {
			error: "not_git_repo",
			message: "Workspace is not a git repository",
		};
	}

	// Validate the parent commit exists
	const parentExists = await commitExists(workspaceRoot, parent);
	if (!parentExists) {
		return {
			error: "invalid_parent",
			message: `Parent commit ${parent} does not exist in repository`,
		};
	}

	// Check if parent is actually an ancestor of HEAD
	try {
		await execAsync(`git merge-base --is-ancestor "${parent}" HEAD`, {
			cwd: workspaceRoot,
		});
	} catch {
		// Not an ancestor - could be a parent mismatch
		return {
			error: "parent_mismatch",
			message: `Commit ${parent} is not an ancestor of HEAD`,
		};
	}

	// Count commits since parent
	const commitCount = await countCommits(workspaceRoot, parent);
	if (commitCount === 0) {
		return {
			error: "no_commits",
			message: `No commits found between ${parent} and HEAD`,
		};
	}

	// Generate format-patch output
	// --stdout outputs to stdout instead of files
	// --keep-subject preserves [PATCH] prefix behavior
	try {
		const { stdout } = await execAsync(
			`git format-patch --stdout "${parent}..HEAD"`,
			{
				cwd: workspaceRoot,
				maxBuffer: 50 * 1024 * 1024, // 50MB for large patches
			},
		);

		return {
			patches: stdout,
			commitCount,
		};
	} catch (err) {
		const execErr = err as { message?: string };
		return {
			error: "no_commits",
			message: `Failed to generate patches: ${execErr.message || "unknown error"}`,
		};
	}
}
