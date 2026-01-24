import assert from "node:assert";
import { describe, it } from "node:test";
import type { SessionDiffFileEntry, SessionFileEntry } from "../api-types";
import {
	type LazyFileNode,
	entriesToNodes,
	hasChangedDescendant,
	shouldAutoExpand,
} from "./use-session-files";

describe("shouldAutoExpand", () => {
	it("should return the directory node when there is exactly one directory child", () => {
		const nodes: LazyFileNode[] = [
			{ name: "subdir", path: "parent/subdir", type: "directory" },
		];

		const result = shouldAutoExpand(nodes);

		assert.notStrictEqual(result, null);
		assert.strictEqual(result?.path, "parent/subdir");
		assert.strictEqual(result?.type, "directory");
	});

	it("should return null when there are multiple children", () => {
		const nodes: LazyFileNode[] = [
			{ name: "subdir1", path: "parent/subdir1", type: "directory" },
			{ name: "subdir2", path: "parent/subdir2", type: "directory" },
		];

		const result = shouldAutoExpand(nodes);

		assert.strictEqual(result, null);
	});

	it("should return null when the single child is a file", () => {
		const nodes: LazyFileNode[] = [
			{ name: "file.txt", path: "parent/file.txt", type: "file" },
		];

		const result = shouldAutoExpand(nodes);

		assert.strictEqual(result, null);
	});

	it("should return null when there are no children", () => {
		const nodes: LazyFileNode[] = [];

		const result = shouldAutoExpand(nodes);

		assert.strictEqual(result, null);
	});

	it("should return null when there is one directory and one file", () => {
		const nodes: LazyFileNode[] = [
			{ name: "subdir", path: "parent/subdir", type: "directory" },
			{ name: "file.txt", path: "parent/file.txt", type: "file" },
		];

		const result = shouldAutoExpand(nodes);

		assert.strictEqual(result, null);
	});
});

describe("entriesToNodes", () => {
	it("should convert file entries to LazyFileNodes", () => {
		const entries: SessionFileEntry[] = [
			{ name: "file.txt", type: "file", size: 100 },
			{ name: "subdir", type: "directory" },
		];
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>();

		const result = entriesToNodes(entries, ".", diffEntriesMap);

		// Directories should be sorted first
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].name, "subdir");
		assert.strictEqual(result[0].type, "directory");
		assert.strictEqual(result[0].path, "subdir");
		assert.strictEqual(result[1].name, "file.txt");
		assert.strictEqual(result[1].type, "file");
		assert.strictEqual(result[1].path, "file.txt");
	});

	it("should build correct paths for nested directories", () => {
		const entries: SessionFileEntry[] = [
			{ name: "nested", type: "directory" },
		];
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>();

		const result = entriesToNodes(entries, "parent/child", diffEntriesMap);

		assert.strictEqual(result[0].path, "parent/child/nested");
	});

	it("should mark files as changed when they have diff entries", () => {
		const entries: SessionFileEntry[] = [
			{ name: "changed.txt", type: "file", size: 100 },
			{ name: "unchanged.txt", type: "file", size: 200 },
		];
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>([
			["changed.txt", { path: "changed.txt", status: "modified" }],
		]);

		const result = entriesToNodes(entries, ".", diffEntriesMap);

		const changedFile = result.find((n) => n.name === "changed.txt");
		const unchangedFile = result.find((n) => n.name === "unchanged.txt");

		assert.strictEqual(changedFile?.changed, true);
		assert.strictEqual(changedFile?.status, "modified");
		assert.strictEqual(unchangedFile?.changed, false);
		assert.strictEqual(unchangedFile?.status, undefined);
	});

	it("should sort directories before files, then alphabetically", () => {
		const entries: SessionFileEntry[] = [
			{ name: "zebra.txt", type: "file", size: 100 },
			{ name: "alpha", type: "directory" },
			{ name: "apple.txt", type: "file", size: 100 },
			{ name: "beta", type: "directory" },
		];
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>();

		const result = entriesToNodes(entries, ".", diffEntriesMap);

		assert.strictEqual(result[0].name, "alpha");
		assert.strictEqual(result[1].name, "beta");
		assert.strictEqual(result[2].name, "apple.txt");
		assert.strictEqual(result[3].name, "zebra.txt");
	});
});

describe("hasChangedDescendant", () => {
	it("should return true when a direct child is changed", () => {
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>([
			["parent/child.txt", { path: "parent/child.txt", status: "modified" }],
		]);

		const result = hasChangedDescendant("parent", diffEntriesMap);

		assert.strictEqual(result, true);
	});

	it("should return true when a nested descendant is changed", () => {
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>([
			[
				"parent/child/grandchild.txt",
				{ path: "parent/child/grandchild.txt", status: "added" },
			],
		]);

		const result = hasChangedDescendant("parent", diffEntriesMap);

		assert.strictEqual(result, true);
	});

	it("should return false when no descendants are changed", () => {
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>([
			["other/file.txt", { path: "other/file.txt", status: "modified" }],
		]);

		const result = hasChangedDescendant("parent", diffEntriesMap);

		assert.strictEqual(result, false);
	});

	it("should handle root path correctly", () => {
		const diffEntriesMap = new Map<string, SessionDiffFileEntry>([
			["any/nested/file.txt", { path: "any/nested/file.txt", status: "added" }],
		]);

		const result = hasChangedDescendant(".", diffEntriesMap);

		assert.strictEqual(result, true);
	});
});

describe("Auto-expand recursion pattern (lazy loading mode)", () => {
	// Simulate the auto-expansion logic that happens in expandDirectory
	// when children need to be fetched from API (lazy loading mode)

	interface MockDirectoryData {
		[path: string]: SessionFileEntry[];
	}

	function simulateAutoExpandLazy(
		startPath: string,
		directoryData: MockDirectoryData,
		diffEntriesMap: Map<string, SessionDiffFileEntry>,
	): { expandedPaths: string[]; cacheUpdates: Map<string, LazyFileNode[]> } {
		const expandedPaths: string[] = [startPath];
		const cacheUpdates = new Map<string, LazyFileNode[]>();

		let currentPath = startPath;

		while (true) {
			const entries = directoryData[currentPath] || [];
			const nodes = entriesToNodes(entries, currentPath, diffEntriesMap);
			cacheUpdates.set(currentPath, nodes);

			const autoExpandNode = shouldAutoExpand(nodes);
			if (autoExpandNode) {
				expandedPaths.push(autoExpandNode.path);
				currentPath = autoExpandNode.path;
			} else {
				break;
			}
		}

		return { expandedPaths, cacheUpdates };
	}

	it("should expand through a chain of single-child directories", () => {
		const directoryData: MockDirectoryData = {
			".": [{ name: "src", type: "directory" }],
			src: [{ name: "components", type: "directory" }],
			"src/components": [{ name: "ui", type: "directory" }],
			"src/components/ui": [
				{ name: "Button.tsx", type: "file", size: 100 },
				{ name: "Input.tsx", type: "file", size: 100 },
			],
		};

		const result = simulateAutoExpandLazy(
			".",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [
			".",
			"src",
			"src/components",
			"src/components/ui",
		]);
		assert.strictEqual(result.cacheUpdates.size, 4);
	});

	it("should stop at a directory with multiple children", () => {
		const directoryData: MockDirectoryData = {
			".": [{ name: "src", type: "directory" }],
			src: [
				{ name: "components", type: "directory" },
				{ name: "utils", type: "directory" },
			],
		};

		const result = simulateAutoExpandLazy(
			".",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [".", "src"]);
		assert.strictEqual(result.cacheUpdates.size, 2);
	});

	it("should stop at a directory with a single file", () => {
		const directoryData: MockDirectoryData = {
			".": [{ name: "src", type: "directory" }],
			src: [{ name: "index.ts", type: "file", size: 50 }],
		};

		const result = simulateAutoExpandLazy(
			".",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [".", "src"]);
		assert.strictEqual(result.cacheUpdates.size, 2);
	});

	it("should stop at an empty directory", () => {
		const directoryData: MockDirectoryData = {
			".": [{ name: "empty", type: "directory" }],
			empty: [],
		};

		const result = simulateAutoExpandLazy(
			".",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [".", "empty"]);
		assert.strictEqual(result.cacheUpdates.size, 2);
	});

	it("should handle deeply nested single-child chains", () => {
		const directoryData: MockDirectoryData = {
			".": [{ name: "a", type: "directory" }],
			a: [{ name: "b", type: "directory" }],
			"a/b": [{ name: "c", type: "directory" }],
			"a/b/c": [{ name: "d", type: "directory" }],
			"a/b/c/d": [{ name: "e", type: "directory" }],
			"a/b/c/d/e": [{ name: "final.txt", type: "file", size: 10 }],
		};

		const result = simulateAutoExpandLazy(
			".",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [
			".",
			"a",
			"a/b",
			"a/b/c",
			"a/b/c/d",
			"a/b/c/d/e",
		]);
		assert.strictEqual(result.cacheUpdates.size, 6);
	});

	it("should expand from a non-root starting path", () => {
		const directoryData: MockDirectoryData = {
			"src/components": [{ name: "ui", type: "directory" }],
			"src/components/ui": [{ name: "buttons", type: "directory" }],
			"src/components/ui/buttons": [
				{ name: "Primary.tsx", type: "file", size: 100 },
			],
		};

		const result = simulateAutoExpandLazy(
			"src/components",
			directoryData,
			new Map<string, SessionDiffFileEntry>(),
		);

		assert.deepStrictEqual(result.expandedPaths, [
			"src/components",
			"src/components/ui",
			"src/components/ui/buttons",
		]);
	});
});

describe("Auto-expand for pre-built trees (changed files only mode)", () => {
	// Simulate the auto-expansion logic that happens when the tree
	// is pre-built from changed files and children are already populated

	function simulateAutoExpandPrebuilt(
		startPath: string,
		tree: LazyFileNode[],
	): string[] {
		const expandedPaths: string[] = [startPath];

		// Find starting node's children
		function findChildren(path: string): LazyFileNode[] | undefined {
			if (path === ".") return tree;

			const parts = path.split("/");
			let nodes = tree;

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const node = nodes.find((n) => n.name === part);
				if (!node) return undefined;
				if (i === parts.length - 1) return node.children;
				if (!node.children) return undefined;
				nodes = node.children;
			}
			return undefined;
		}

		let currentChildren = findChildren(startPath);

		while (currentChildren) {
			const autoExpandNode = shouldAutoExpand(currentChildren);
			if (autoExpandNode?.children) {
				expandedPaths.push(autoExpandNode.path);
				currentChildren = autoExpandNode.children;
			} else {
				break;
			}
		}

		return expandedPaths;
	}

	it("should expand through a chain of single-child directories in pre-built tree", () => {
		const tree: LazyFileNode[] = [
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "components",
						path: "src/components",
						type: "directory",
						children: [
							{
								name: "ui",
								path: "src/components/ui",
								type: "directory",
								children: [
									{
										name: "Button.tsx",
										path: "src/components/ui/Button.tsx",
										type: "file",
									},
									{
										name: "Input.tsx",
										path: "src/components/ui/Input.tsx",
										type: "file",
									},
								],
							},
						],
					},
				],
			},
		];

		const result = simulateAutoExpandPrebuilt(".", tree);

		assert.deepStrictEqual(result, [
			".",
			"src",
			"src/components",
			"src/components/ui",
		]);
	});

	it("should stop at a directory with multiple children in pre-built tree", () => {
		const tree: LazyFileNode[] = [
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "components",
						path: "src/components",
						type: "directory",
						children: [],
					},
					{
						name: "utils",
						path: "src/utils",
						type: "directory",
						children: [],
					},
				],
			},
		];

		const result = simulateAutoExpandPrebuilt(".", tree);

		assert.deepStrictEqual(result, [".", "src"]);
	});

	it("should stop when single child has no children populated", () => {
		const tree: LazyFileNode[] = [
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "components",
						path: "src/components",
						type: "directory",
						// children is undefined - not loaded
					},
				],
			},
		];

		const result = simulateAutoExpandPrebuilt(".", tree);

		// Should expand to src, but stop at components because children aren't loaded
		assert.deepStrictEqual(result, [".", "src"]);
	});

	it("should expand from a nested starting path", () => {
		const tree: LazyFileNode[] = [
			{
				name: "src",
				path: "src",
				type: "directory",
				children: [
					{
						name: "components",
						path: "src/components",
						type: "directory",
						children: [
							{
								name: "ui",
								path: "src/components/ui",
								type: "directory",
								children: [
									{
										name: "buttons",
										path: "src/components/ui/buttons",
										type: "directory",
										children: [
											{
												name: "Primary.tsx",
												path: "src/components/ui/buttons/Primary.tsx",
												type: "file",
											},
										],
									},
								],
							},
						],
					},
				],
			},
		];

		const result = simulateAutoExpandPrebuilt("src/components", tree);

		assert.deepStrictEqual(result, [
			"src/components",
			"src/components/ui",
			"src/components/ui/buttons",
		]);
	});

	it("should handle deeply nested single-child chains in pre-built tree", () => {
		const tree: LazyFileNode[] = [
			{
				name: "a",
				path: "a",
				type: "directory",
				children: [
					{
						name: "b",
						path: "a/b",
						type: "directory",
						children: [
							{
								name: "c",
								path: "a/b/c",
								type: "directory",
								children: [
									{
										name: "d",
										path: "a/b/c/d",
										type: "directory",
										children: [
											{ name: "file.txt", path: "a/b/c/d/file.txt", type: "file" },
										],
									},
								],
							},
						],
					},
				],
			},
		];

		const result = simulateAutoExpandPrebuilt(".", tree);

		assert.deepStrictEqual(result, [".", "a", "a/b", "a/b/c", "a/b/c/d"]);
	});
});
