import assert from "node:assert";
import { describe, it } from "node:test";
import { getSessionDirectoryForCwd } from "./persistence.js";

describe("persistence", () => {
	describe("getSessionDirectoryForCwd", () => {
		it("encodes cwd path correctly", () => {
			const cwd = "/home/user/workspace";
			const result = getSessionDirectoryForCwd(cwd);

			// Should remove leading slash and replace remaining slashes with dashes
			assert.ok(result.includes("home-user-workspace"));
			assert.ok(result.includes(".claude/projects"));
		});

		it("handles root directory", () => {
			const cwd = "/";
			const result = getSessionDirectoryForCwd(cwd);

			// Root should become empty string after removing leading slash
			assert.ok(result.includes(".claude/projects"));
		});

		it("handles nested paths", () => {
			const cwd = "/var/www/html/project";
			const result = getSessionDirectoryForCwd(cwd);

			assert.ok(result.includes("var-www-html-project"));
		});

		it("handles paths with multiple levels", () => {
			const cwd = "/a/b/c/d/e";
			const result = getSessionDirectoryForCwd(cwd);

			assert.ok(result.includes("a-b-c-d-e"));
			assert.ok(!result.includes("//"));
			assert.ok(!result.startsWith("-"));
		});

		it("produces consistent results", () => {
			const cwd = "/home/user/workspace";
			const result1 = getSessionDirectoryForCwd(cwd);
			const result2 = getSessionDirectoryForCwd(cwd);

			assert.strictEqual(result1, result2);
		});
	});

	// Note: Integration tests for discoverSessions, loadSessionMessages, etc.
	// should be written as separate integration tests that use actual test
	// session files, rather than complex mocking of fs/promises.
	// See test/integration/ for these tests.
});
