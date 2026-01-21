import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { getCommitPatches, isCommitsError } from "./commits.js";

const execAsync = promisify(exec);

/**
 * Helper to run git commands in a directory
 * Uses spawn-like approach with proper argument escaping
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
	// Properly escape each argument for shell
	const escapedArgs = args.map((arg) => {
		// If argument contains spaces or special chars, quote it
		if (/[\s"'\\]/.test(arg)) {
			return `"${arg.replace(/"/g, '\\"')}"`;
		}
		return arg;
	});
	const { stdout } = await execAsync(`git ${escapedArgs.join(" ")}`, { cwd });
	return stdout.trim();
}

/**
 * Helper to create a git repo with initial commit
 */
async function createGitRepo(dir: string): Promise<string> {
	await mkdir(dir, { recursive: true });
	await git(dir, "init");
	await git(dir, "config", "user.email", "test@example.com");
	await git(dir, "config", "user.name", "Test User");

	// Create initial commit
	await writeFile(join(dir, "README.md"), "# Test Repository\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-m", "Initial commit");

	// Return the initial commit SHA
	return git(dir, "rev-parse", "HEAD");
}

describe("isCommitsError", () => {
	it("returns true for error response", () => {
		const result = {
			error: "parent_mismatch" as const,
			message: "Parent does not match",
		};
		assert.equal(isCommitsError(result), true);
	});

	it("returns false for success response", () => {
		const result = {
			patches: "some patches",
			commitCount: 1,
		};
		assert.equal(isCommitsError(result), false);
	});
});

describe("getCommitPatches", () => {
	const testDir = "/tmp/agent-api-commits-test";

	before(async () => {
		// Clean up any existing test directory
		await rm(testDir, { recursive: true, force: true });
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	describe("error cases", () => {
		it("returns invalid_parent for empty parent", async () => {
			const repoDir = join(testDir, "empty-parent");
			await createGitRepo(repoDir);

			const result = await getCommitPatches(repoDir, "");

			assert.equal(isCommitsError(result), true);
			if (isCommitsError(result)) {
				assert.equal(result.error, "invalid_parent");
			}
		});

		it("returns not_git_repo for non-git directory", async () => {
			const nonGitDir = join(testDir, "not-git");
			await mkdir(nonGitDir, { recursive: true });
			await writeFile(join(nonGitDir, "file.txt"), "content");

			const result = await getCommitPatches(nonGitDir, "abc123");

			assert.equal(isCommitsError(result), true);
			if (isCommitsError(result)) {
				assert.equal(result.error, "not_git_repo");
			}
		});

		it("returns invalid_parent for non-existent commit", async () => {
			const repoDir = join(testDir, "nonexistent-commit");
			await createGitRepo(repoDir);

			const result = await getCommitPatches(
				repoDir,
				"0000000000000000000000000000000000000000",
			);

			assert.equal(isCommitsError(result), true);
			if (isCommitsError(result)) {
				assert.equal(result.error, "invalid_parent");
			}
		});

		it("returns no_commits when parent is HEAD", async () => {
			const repoDir = join(testDir, "no-commits");
			const initialCommit = await createGitRepo(repoDir);

			const result = await getCommitPatches(repoDir, initialCommit);

			assert.equal(isCommitsError(result), true);
			if (isCommitsError(result)) {
				assert.equal(result.error, "no_commits");
			}
		});

		it("returns parent_mismatch when parent is not an ancestor", async () => {
			const repoDir = join(testDir, "not-ancestor");
			await createGitRepo(repoDir);

			// Get the current branch name (could be main or master)
			const mainBranch = await git(
				repoDir,
				"rev-parse",
				"--abbrev-ref",
				"HEAD",
			);

			// Create a commit on a branch
			await git(repoDir, "checkout", "-b", "branch1");
			await writeFile(join(repoDir, "branch1.txt"), "branch1 content");
			await git(repoDir, "add", "branch1.txt");
			await git(repoDir, "commit", "-m", "Branch 1 commit");
			const branch1Commit = await git(repoDir, "rev-parse", "HEAD");

			// Go back to main and create a different commit
			await git(repoDir, "checkout", mainBranch);
			await writeFile(join(repoDir, "main.txt"), "main content");
			await git(repoDir, "add", "main.txt");
			await git(repoDir, "commit", "-m", "Main commit");

			// branch1Commit is not an ancestor of main HEAD
			const result = await getCommitPatches(repoDir, branch1Commit);

			assert.equal(isCommitsError(result), true);
			if (isCommitsError(result)) {
				assert.equal(result.error, "parent_mismatch");
			}
		});
	});

	describe("success cases", () => {
		it("returns patches for a single commit", async () => {
			const repoDir = join(testDir, "single-commit");
			const initialCommit = await createGitRepo(repoDir);

			// Add a new commit
			await writeFile(join(repoDir, "new-file.txt"), "New content\n");
			await git(repoDir, "add", "new-file.txt");
			await git(repoDir, "commit", "-m", "Add new file");

			const result = await getCommitPatches(repoDir, initialCommit);

			assert.equal(isCommitsError(result), false);
			if (!isCommitsError(result)) {
				assert.equal(result.commitCount, 1);
				assert.ok(result.patches.length > 0, "Should have patches");
				assert.ok(
					result.patches.includes("Add new file"),
					"Should include commit message",
				);
				assert.ok(
					result.patches.includes("new-file.txt"),
					"Should include filename",
				);
				assert.ok(
					result.patches.includes("New content"),
					"Should include file content",
				);
			}
		});

		it("returns patches for multiple commits", async () => {
			const repoDir = join(testDir, "multiple-commits");
			const initialCommit = await createGitRepo(repoDir);

			// Add first commit
			await writeFile(join(repoDir, "file1.txt"), "File 1 content\n");
			await git(repoDir, "add", "file1.txt");
			await git(repoDir, "commit", "-m", "Add file 1");

			// Add second commit
			await writeFile(join(repoDir, "file2.txt"), "File 2 content\n");
			await git(repoDir, "add", "file2.txt");
			await git(repoDir, "commit", "-m", "Add file 2");

			// Add third commit
			await writeFile(join(repoDir, "file3.txt"), "File 3 content\n");
			await git(repoDir, "add", "file3.txt");
			await git(repoDir, "commit", "-m", "Add file 3");

			const result = await getCommitPatches(repoDir, initialCommit);

			assert.equal(isCommitsError(result), false);
			if (!isCommitsError(result)) {
				assert.equal(result.commitCount, 3);
				assert.ok(result.patches.includes("Add file 1"));
				assert.ok(result.patches.includes("Add file 2"));
				assert.ok(result.patches.includes("Add file 3"));
			}
		});

		it("preserves commit metadata in patches", async () => {
			const repoDir = join(testDir, "metadata");
			const initialCommit = await createGitRepo(repoDir);

			// Create a commit with specific author
			await writeFile(join(repoDir, "authored.txt"), "Authored content\n");
			await git(repoDir, "add", "authored.txt");
			await git(
				repoDir,
				"commit",
				"--author",
				"Custom Author <custom@example.com>",
				"-m",
				"Commit with custom author",
			);

			const result = await getCommitPatches(repoDir, initialCommit);

			assert.equal(isCommitsError(result), false);
			if (!isCommitsError(result)) {
				assert.ok(
					result.patches.includes("Custom Author"),
					"Should preserve author name",
				);
				assert.ok(
					result.patches.includes("custom@example.com"),
					"Should preserve author email",
				);
			}
		});

		it("handles commits from intermediate parent", async () => {
			const repoDir = join(testDir, "intermediate-parent");
			await createGitRepo(repoDir);

			// Add first commit
			await writeFile(join(repoDir, "file1.txt"), "File 1\n");
			await git(repoDir, "add", "file1.txt");
			await git(repoDir, "commit", "-m", "Commit 1");
			const commit1 = await git(repoDir, "rev-parse", "HEAD");

			// Add second commit
			await writeFile(join(repoDir, "file2.txt"), "File 2\n");
			await git(repoDir, "add", "file2.txt");
			await git(repoDir, "commit", "-m", "Commit 2");

			// Add third commit
			await writeFile(join(repoDir, "file3.txt"), "File 3\n");
			await git(repoDir, "add", "file3.txt");
			await git(repoDir, "commit", "-m", "Commit 3");

			// Get patches from commit1 (should only include commits 2 and 3)
			const result = await getCommitPatches(repoDir, commit1);

			assert.equal(isCommitsError(result), false);
			if (!isCommitsError(result)) {
				assert.equal(result.commitCount, 2);
				assert.ok(
					!result.patches.includes("Commit 1"),
					"Should not include commit 1",
				);
				assert.ok(
					result.patches.includes("Commit 2"),
					"Should include commit 2",
				);
				assert.ok(
					result.patches.includes("Commit 3"),
					"Should include commit 3",
				);
			}
		});

		it("handles binary files in patches", async () => {
			const repoDir = join(testDir, "binary-files");
			const initialCommit = await createGitRepo(repoDir);

			// Create a binary file (PNG header)
			const binaryContent = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
			]);
			await writeFile(join(repoDir, "image.png"), binaryContent);
			await git(repoDir, "add", "image.png");
			await git(repoDir, "commit", "-m", "Add binary file");

			const result = await getCommitPatches(repoDir, initialCommit);

			assert.equal(isCommitsError(result), false);
			if (!isCommitsError(result)) {
				assert.equal(result.commitCount, 1);
				assert.ok(result.patches.includes("image.png"));
			}
		});
	});
});
