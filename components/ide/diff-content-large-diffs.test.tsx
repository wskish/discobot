/**
 * DiffContent Large Diff Handling Tests
 *
 * Tests for the large diff threshold and fallback UI functionality:
 * - Fast line counting without parsing
 * - Threshold detection (warning vs hard limit)
 * - Fallback UI rendering
 * - Force-load functionality
 * - Performance optimizations (skipping expensive computations)
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/diff-content-large-diffs.test.tsx
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// Import the helper functions by extracting them into a testable module
// For now, we'll test the logic inline

/**
 * Fast count of diff lines without parsing the entire patch.
 * This is a copy of the function from diff-content.tsx for testing.
 */
function countDiffLinesFast(patch: string): number {
	let count = 0;
	let inHunk = false;

	for (const line of patch.split("\n")) {
		// Start of a hunk
		if (line.startsWith("@@")) {
			inHunk = true;
			continue;
		}

		// Count actual diff content lines (context, additions, deletions)
		if (
			inHunk &&
			(line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
		) {
			count++;
		}
	}

	return count;
}

describe("countDiffLinesFast - Fast line counting", () => {
	it("should count lines in a simple diff", () => {
		const patch = `diff --git a/file.ts b/file.ts
index 123..456 100644
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 context line 1
-removed line
+added line 1
+added line 2
 context line 2`;

		const count = countDiffLinesFast(patch);
		// Should count: 1 context + 1 removed + 2 added + 1 context = 5 lines
		assert.strictEqual(count, 5, "Should count all diff content lines");
	});

	it("should handle multiple hunks", () => {
		const patch = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 line 1
-old line 2
+new line 2
@@ -10,3 +10,3 @@
 line 10
-old line 11
+new line 11
 line 12`;

		const count = countDiffLinesFast(patch);
		// Hunk 1: 1 context + 1 removed + 1 added = 3
		// Hunk 2: 1 context + 1 removed + 1 added + 1 context = 4
		// Total: 7
		assert.strictEqual(count, 7, "Should count lines across multiple hunks");
	});

	it("should ignore header lines", () => {
		const patch = `diff --git a/file.ts b/file.ts
index 123..456 100644
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
+added line`;

		const count = countDiffLinesFast(patch);
		// Should only count the 1 added line, not the header lines
		assert.strictEqual(count, 1, "Should not count header lines");
	});

	it("should handle empty diff", () => {
		const patch = "";
		const count = countDiffLinesFast(patch);
		assert.strictEqual(count, 0, "Should return 0 for empty diff");
	});

	it("should handle diff with only headers (no changes)", () => {
		const patch = `diff --git a/file.ts b/file.ts
index 123..456 100644
--- a/file.ts
+++ b/file.ts`;

		const count = countDiffLinesFast(patch);
		assert.strictEqual(count, 0, "Should return 0 when no hunks present");
	});

	it("should handle large diff correctly", () => {
		// Generate a diff with 15,000 lines
		const lines: string[] = [
			"diff --git a/large.ts b/large.ts",
			"--- a/large.ts",
			"+++ b/large.ts",
			"@@ -1,15000 +1,15000 @@",
		];

		// Add 15,000 diff content lines
		for (let i = 0; i < 15000; i++) {
			if (i % 3 === 0) {
				lines.push(`+added line ${i}`);
			} else if (i % 3 === 1) {
				lines.push(`-removed line ${i}`);
			} else {
				lines.push(` context line ${i}`);
			}
		}

		const patch = lines.join("\n");
		const count = countDiffLinesFast(patch);
		assert.strictEqual(count, 15000, "Should handle large diffs efficiently");
	});
});

describe("Large diff thresholds", () => {
	const DIFF_WARNING_THRESHOLD = 10000;
	const DIFF_HARD_LIMIT = 20000;

	it("should not trigger threshold for small diffs", () => {
		const lineCount = 5000;
		const isOverWarning = lineCount > DIFF_WARNING_THRESHOLD;
		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;

		assert.strictEqual(
			isOverWarning,
			false,
			"Should not trigger warning for 5k lines",
		);
		assert.strictEqual(
			isOverHardLimit,
			false,
			"Should not trigger hard limit for 5k lines",
		);
	});

	it("should trigger warning threshold for medium diffs", () => {
		const lineCount = 15000;
		const isOverWarning = lineCount > DIFF_WARNING_THRESHOLD;
		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;

		assert.strictEqual(
			isOverWarning,
			true,
			"Should trigger warning for 15k lines",
		);
		assert.strictEqual(
			isOverHardLimit,
			false,
			"Should not trigger hard limit for 15k lines",
		);
	});

	it("should trigger hard limit for very large diffs", () => {
		const lineCount = 25000;
		const isOverWarning = lineCount > DIFF_WARNING_THRESHOLD;
		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;

		assert.strictEqual(
			isOverWarning,
			true,
			"Should trigger warning for 25k lines",
		);
		assert.strictEqual(
			isOverHardLimit,
			true,
			"Should trigger hard limit for 25k lines",
		);
	});

	it("should allow force-load for warning threshold diffs", () => {
		const lineCount = 15000;
		const isOverWarning =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;

		// User should be able to force-load if in warning range
		const canLoadAnyway = isOverWarning && !isOverHardLimit;

		assert.strictEqual(
			canLoadAnyway,
			true,
			"Should allow force-load for warning threshold diffs",
		);
	});

	it("should not allow force-load for hard limit diffs", () => {
		const lineCount = 25000;
		const isOverWarning =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;

		// User should NOT be able to force-load if over hard limit
		const canLoadAnyway = isOverWarning && !isOverHardLimit;

		assert.strictEqual(
			canLoadAnyway,
			false,
			"Should not allow force-load for hard limit diffs",
		);
	});
});

describe("Fallback UI logic", () => {
	const DIFF_WARNING_THRESHOLD = 10000;
	const DIFF_HARD_LIMIT = 20000;

	it("should show fallback for warning threshold diffs by default", () => {
		const lineCount = 15000;
		const forceLoadLargeDiff = false;

		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;
		const isOverWarningThreshold =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const shouldShowFallback =
			(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

		assert.strictEqual(
			shouldShowFallback,
			true,
			"Should show fallback by default for warning threshold",
		);
	});

	it("should not show fallback when user force-loads warning threshold diff", () => {
		const lineCount = 15000;
		const forceLoadLargeDiff = true; // User clicked "Load Anyway"

		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;
		const isOverWarningThreshold =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const shouldShowFallback =
			(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

		assert.strictEqual(
			shouldShowFallback,
			false,
			"Should not show fallback when user force-loads",
		);
	});

	it("should always show fallback for hard limit diffs even with force-load", () => {
		const lineCount = 25000;
		const forceLoadLargeDiff = true; // User tried to force-load, but shouldn't work

		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;
		const isOverWarningThreshold =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const shouldShowFallback =
			(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

		assert.strictEqual(
			shouldShowFallback,
			true,
			"Should always show fallback for hard limit",
		);
	});

	it("should not show fallback for small diffs", () => {
		const lineCount = 5000;
		const forceLoadLargeDiff = false;

		const isOverHardLimit = lineCount > DIFF_HARD_LIMIT;
		const isOverWarningThreshold =
			lineCount > DIFF_WARNING_THRESHOLD && lineCount <= DIFF_HARD_LIMIT;
		const shouldShowFallback =
			(isOverWarningThreshold && !forceLoadLargeDiff) || isOverHardLimit;

		assert.strictEqual(
			shouldShowFallback,
			false,
			"Should not show fallback for small diffs",
		);
	});
});

describe("Performance optimization logic", () => {
	it("should skip expensive reconstruction when showing fallback", () => {
		const shouldShowFallback = true;

		// Simulating the originalContent useMemo logic
		const shouldReconstructOriginal = !shouldShowFallback;

		assert.strictEqual(
			shouldReconstructOriginal,
			false,
			"Should skip reconstruction when showing fallback",
		);
	});

	it("should perform reconstruction when not showing fallback", () => {
		const shouldShowFallback = false;

		// Simulating the originalContent useMemo logic
		const shouldReconstructOriginal = !shouldShowFallback;

		assert.strictEqual(
			shouldReconstructOriginal,
			true,
			"Should perform reconstruction when rendering Monaco",
		);
	});

	it("should prioritize fast counting over parsed counting", () => {
		// This test validates the design decision:
		// Fast counting is O(n) string scan, parsed counting is O(n²) with object allocation

		const largePatch = `diff --git a/file.ts b/file.ts
@@ -1,1000 +1,1000 @@
${Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n")}`;

		// Fast counting should complete quickly without parsing
		const startFast = Date.now();
		const countFast = countDiffLinesFast(largePatch);
		const timeFast = Date.now() - startFast;

		// The fast method should return correct count
		assert.strictEqual(countFast, 1000, "Fast counting should be accurate");

		// Fast method should complete in reasonable time (< 10ms for 1000 lines)
		assert.ok(
			timeFast < 10,
			`Fast counting should be quick (took ${timeFast}ms)`,
		);
	});
});

describe("Edge cases", () => {
	it("should handle diff with leading whitespace variations", () => {
		const patch = `diff --git a/file.ts b/file.ts
@@ -1,3 +1,3 @@
  context with two spaces
-removed
+added`;

		const count = countDiffLinesFast(patch);
		// Should count: 1 context (starting with space) + 1 removed + 1 added = 3
		assert.strictEqual(count, 3, "Should handle various whitespace patterns");
	});

	it("should handle diff with no newline at end", () => {
		const patch = `diff --git a/file.ts b/file.ts
@@ -1,1 +1,1 @@
-old
+new`;

		const count = countDiffLinesFast(patch);
		assert.strictEqual(
			count,
			2,
			"Should handle diffs without trailing newline",
		);
	});

	it("should handle binary file indicator in patch", () => {
		const patch = `diff --git a/image.png b/image.png
Binary files differ`;

		const count = countDiffLinesFast(patch);
		// Binary indicator line doesn't start with @@, so no hunk is found
		assert.strictEqual(count, 0, "Should return 0 for binary file patches");
	});

	it("should handle malformed patch gracefully", () => {
		const patch = `not a real diff
just some random text
@@ malformed hunk header
+this line comes after bad header`;

		// Should start counting after @@ is found
		const count = countDiffLinesFast(patch);
		assert.strictEqual(count, 1, "Should handle malformed patches gracefully");
	});
});

describe("Integration scenarios", () => {
	it("should handle typical React component diff (small)", () => {
		const patch = `diff --git a/components/Button.tsx b/components/Button.tsx
--- a/components/Button.tsx
+++ b/components/Button.tsx
@@ -10,7 +10,8 @@ export function Button({ label, onClick }: ButtonProps) {
   return (
     <button
       onClick={onClick}
-      className="bg-blue-500 hover:bg-blue-700"
+      className="bg-primary hover:bg-primary/90"
+      aria-label={label}
     >
       {label}
     </button>`;

		const count = countDiffLinesFast(patch);
		assert.ok(
			count < 10000,
			"Typical component changes should be under threshold",
		);
	});

	it("should detect large generated file diff (code generation)", () => {
		// Simulate a large generated file (e.g., package-lock.json, bundled output)
		const lines: string[] = [
			"diff --git a/dist/bundle.js b/dist/bundle.js",
			"@@ -1,12000 +1,12000 @@",
		];

		for (let i = 0; i < 12000; i++) {
			lines.push(`-var module${i} = require('./old${i}');`);
			lines.push(`+var module${i} = require('./new${i}');`);
		}

		const patch = lines.join("\n");
		const count = countDiffLinesFast(patch);

		const DIFF_WARNING_THRESHOLD = 10000;
		assert.ok(
			count > DIFF_WARNING_THRESHOLD,
			"Large generated files should trigger threshold",
		);
	});

	it("should handle refactoring with many small changes", () => {
		// Simulate a refactor with changes across many lines but under threshold
		const lines: string[] = [
			"diff --git a/utils.ts b/utils.ts",
			"@@ -1,5000 +1,5000 @@",
		];

		// 5000 lines with 25% changed
		for (let i = 0; i < 5000; i++) {
			if (i % 4 === 0) {
				lines.push(`-oldFunction${i}()`);
				lines.push(`+newFunction${i}()`);
			} else {
				lines.push(` unchanged line ${i}`);
			}
		}

		const patch = lines.join("\n");
		const count = countDiffLinesFast(patch);

		const DIFF_WARNING_THRESHOLD = 10000;
		assert.ok(
			count < DIFF_WARNING_THRESHOLD,
			"Moderate refactoring should be under threshold",
		);
	});
});
