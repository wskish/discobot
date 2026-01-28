import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { api } from "../api-client";
import type {
	FileStatus,
	SessionDiffFileEntry,
	SessionDiffFilesResponse,
	SessionFileEntry,
	SessionSingleFileDiffResponse,
} from "../api-types";

/**
 * File node for the lazy-loading tree view.
 * Children are loaded on-demand when expanded.
 */
export interface LazyFileNode {
	name: string;
	path: string;
	type: "file" | "directory";
	size?: number;
	/** Children loaded from API (undefined = not loaded, empty = loaded with no children) */
	children?: LazyFileNode[];
	/** Whether this file has been modified in the session (deprecated - use status instead) */
	changed?: boolean;
	/** File status: added, modified, deleted, or renamed */
	status?: FileStatus;
}

/**
 * Determines if a directory should be auto-expanded.
 * Auto-expand when there's exactly one child and it's a directory.
 * @returns The child directory node to expand, or null if no auto-expansion should occur.
 */
export function shouldAutoExpand(nodes: LazyFileNode[]): LazyFileNode | null {
	if (nodes.length === 1 && nodes[0].type === "directory") {
		return nodes[0];
	}
	return null;
}

/**
 * Hook for managing session files with lazy loading.
 * Files are loaded directory-by-directory as folders are expanded.
 * @param sessionId - The session ID to load files for
 * @param loadAllFiles - When false, only shows changed files without loading the full tree
 */
export function useSessionFiles(sessionId: string | null, loadAllFiles = true) {
	// Track which directories are expanded (for lazy loading)
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
		new Set(["."]),
	);

	// Cache of loaded directory contents
	const [childrenCache, setChildrenCache] = useState<
		Map<string, LazyFileNode[]>
	>(new Map());

	// Track paths that are currently loading
	const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());

	// Load root directory listing - only when loadAllFiles is true
	const { data: rootData, isLoading: isLoadingRoot } = useSWR(
		sessionId && loadAllFiles ? `session-files-${sessionId}-root` : null,
		() => (sessionId ? api.listSessionFiles(sessionId, ".") : null),
	);

	// Load diff status (files that have changed) - always load
	const {
		data: diffData,
		isLoading: isLoadingDiff,
		mutate: mutateDiff,
	} = useSWR(sessionId ? `session-diff-${sessionId}-files` : null, async () => {
		if (!sessionId) return null;
		const result = await api.getSessionDiff(sessionId, { format: "files" });
		return result as SessionDiffFilesResponse;
	});

	// Build a map of file path to status for quick lookup
	const diffEntriesMap = useMemo(() => {
		const map = new Map<string, SessionDiffFileEntry>();
		for (const entry of diffData?.files || []) {
			map.set(entry.path, entry);
		}
		return map;
	}, [diffData?.files]);

	// Convert API response to LazyFileNode tree, or build from changed files only
	const rootNodes = useMemo(() => {
		if (loadAllFiles) {
			if (!rootData) return [];
			return entriesToNodes(rootData.entries, ".", diffEntriesMap);
		}
		// Build minimal tree from changed files only
		return buildTreeFromChangedFiles(diffData?.files || []);
	}, [rootData, diffData?.files, diffEntriesMap, loadAllFiles]);

	// Build tree from root nodes and cached children
	const fileTree = useMemo(() => {
		return buildTreeFromCache(rootNodes, childrenCache, diffEntriesMap);
	}, [rootNodes, childrenCache, diffEntriesMap]);

	// Helper to find a node in the tree by path
	const findNodeInTree = useCallback(
		(path: string): LazyFileNode | null => {
			if (path === ".") return null; // Root doesn't have a node

			const parts = path.split("/");
			let nodes = fileTree;

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const node = nodes.find((n) => n.name === part);
				if (!node) return null;
				if (i === parts.length - 1) return node;
				if (!node.children) return null;
				nodes = node.children;
			}
			return null;
		},
		[fileTree],
	);

	// Expand a directory (triggers lazy load)
	// Auto-expands single-child directory chains recursively
	const expandDirectory = useCallback(
		async (path: string) => {
			if (!sessionId) return;

			// Add to expanded set
			setExpandedPaths((prev) => new Set(prev).add(path));

			// Check if children are already loaded in the tree (pre-built tree mode)
			// For root path, check if fileTree has content
			const existingNode = path === "." ? null : findNodeInTree(path);
			const existingChildren =
				path === "."
					? fileTree.length > 0
						? fileTree
						: null
					: existingNode?.children;

			if (existingChildren !== undefined && existingChildren !== null) {
				// Children already loaded - do synchronous auto-expansion
				let currentChildren = existingChildren;
				while (true) {
					const autoExpandNode = shouldAutoExpand(currentChildren);
					if (autoExpandNode?.children) {
						setExpandedPaths((prev) => new Set(prev).add(autoExpandNode.path));
						currentChildren = autoExpandNode.children;
					} else {
						break;
					}
				}
				return;
			}

			// Children not loaded - fetch from API with auto-expansion
			if (loadingPaths.has(path)) return;

			const pathsToLoad: string[] = [path];
			setLoadingPaths((prev) => new Set(prev).add(path));

			try {
				let currentPath = path;
				const cacheUpdates = new Map<string, LazyFileNode[]>();

				// Keep expanding while we find single-child directories
				while (true) {
					const data = await api.listSessionFiles(sessionId, currentPath);
					const nodes = entriesToNodes(
						data.entries,
						currentPath,
						diffEntriesMap,
					);
					cacheUpdates.set(currentPath, nodes);

					// Check if we should auto-expand: exactly one child that's a directory
					const autoExpandNode = shouldAutoExpand(nodes);
					if (autoExpandNode) {
						const childPath = autoExpandNode.path;
						// Add child to expanded paths and loading paths
						setExpandedPaths((prev) => new Set(prev).add(childPath));
						pathsToLoad.push(childPath);
						setLoadingPaths((prev) => new Set(prev).add(childPath));
						currentPath = childPath;
					} else {
						// Multiple children, a file, or empty - stop auto-expanding
						break;
					}
				}

				// Apply all cache updates at once
				setChildrenCache((prev) => {
					const next = new Map(prev);
					for (const [p, nodes] of cacheUpdates) {
						next.set(p, nodes);
					}
					return next;
				});
			} catch {
				// Directory may not exist (ghost directory for deleted files)
				// Use empty entries - entriesToNodes will still add deleted files from diff
				const nodes = entriesToNodes([], path, diffEntriesMap);
				setChildrenCache((prev) => new Map(prev).set(path, nodes));
			} finally {
				setLoadingPaths((prev) => {
					const next = new Set(prev);
					for (const p of pathsToLoad) {
						next.delete(p);
					}
					return next;
				});
			}
		},
		[sessionId, loadingPaths, diffEntriesMap, fileTree, findNodeInTree],
	);

	// Collapse a directory
	const collapseDirectory = useCallback((path: string) => {
		setExpandedPaths((prev) => {
			const next = new Set(prev);
			next.delete(path);
			return next;
		});
	}, []);

	// Toggle expand/collapse
	const toggleDirectory = useCallback(
		(path: string) => {
			if (expandedPaths.has(path)) {
				collapseDirectory(path);
			} else {
				expandDirectory(path);
			}
		},
		[expandedPaths, expandDirectory, collapseDirectory],
	);

	// Refresh files (clear cache and reload diff)
	const refresh = useCallback(() => {
		setChildrenCache(new Map());
		setExpandedPaths(new Set(["."]));
		mutateDiff();
	}, [mutateDiff]);

	// Expand all directories in the current tree, recursively loading unloaded directories
	const expandAll = useCallback(async () => {
		if (!sessionId) return;

		// Capture sessionId as a non-null value for TypeScript
		const currentSessionId = sessionId;

		// Recursively load and expand all directories
		async function loadAllDirectories(
			nodes: LazyFileNode[],
			pathsToExpand: Set<string>,
		): Promise<void> {
			const loadPromises: Promise<void>[] = [];

			for (const node of nodes) {
				if (node.type === "directory") {
					pathsToExpand.add(node.path);

					// If children aren't loaded yet, load them
					if (node.children === undefined && !childrenCache.has(node.path)) {
						loadPromises.push(
							(async () => {
								if (loadingPaths.has(node.path)) return;

								setLoadingPaths((prev) => new Set(prev).add(node.path));

								try {
									const data = await api.listSessionFiles(
										currentSessionId,
										node.path,
									);
									const childNodes = entriesToNodes(
										data.entries,
										node.path,
										diffEntriesMap,
									);
									setChildrenCache((prev) =>
										new Map(prev).set(node.path, childNodes),
									);

									// Recursively process newly loaded children
									await loadAllDirectories(childNodes, pathsToExpand);
								} catch {
									// Directory may not exist (ghost directory for deleted files)
									const childNodes = entriesToNodes(
										[],
										node.path,
										diffEntriesMap,
									);
									setChildrenCache((prev) =>
										new Map(prev).set(node.path, childNodes),
									);
								} finally {
									setLoadingPaths((prev) => {
										const next = new Set(prev);
										next.delete(node.path);
										return next;
									});
								}
							})(),
						);
					} else if (node.children) {
						// Already loaded, recursively process children
						loadPromises.push(loadAllDirectories(node.children, pathsToExpand));
					}
				}
			}

			await Promise.all(loadPromises);
		}

		const pathsToExpand = new Set<string>(["."]);
		await loadAllDirectories(fileTree, pathsToExpand);

		// Set all collected paths as expanded
		setExpandedPaths(pathsToExpand);
	}, [sessionId, fileTree, childrenCache, loadingPaths, diffEntriesMap]);

	// Collapse all directories
	const collapseAll = useCallback(() => {
		setExpandedPaths(new Set(["."]));
	}, []);

	// Check if a path is loading
	const isPathLoading = useCallback(
		(path: string) => loadingPaths.has(path),
		[loadingPaths],
	);

	// For backwards compatibility, extract just the paths
	const changedFilePaths = useMemo(
		() => (diffData?.files || []).map((f) => f.path),
		[diffData?.files],
	);

	return {
		fileTree,
		isLoading: isLoadingRoot || isLoadingDiff,
		diffStats: diffData?.stats,
		/** Changed file paths (for backwards compatibility) */
		changedFiles: changedFilePaths,
		/** Full diff entries with status information */
		diffEntries: diffData?.files || [],
		expandedPaths,
		expandDirectory,
		collapseDirectory,
		toggleDirectory,
		expandAll,
		collapseAll,
		isPathLoading,
		refresh,
	};
}

/**
 * Hook for getting a single file's diff.
 */
export function useSessionFileDiff(
	sessionId: string | null,
	path: string | null,
) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId && path ? `session-diff-${sessionId}-${path}` : null,
		async () => {
			if (!sessionId || !path) return null;
			const result = await api.getSessionDiff(sessionId, { path });
			return result as SessionSingleFileDiffResponse;
		},
	);

	return {
		diff: data,
		isLoading,
		error,
		mutate,
	};
}

/**
 * Hook for reading a single file's content.
 */
export function useSessionFileContent(
	sessionId: string | null,
	path: string | null,
) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId && path ? `session-file-${sessionId}-${path}` : null,
		() => (sessionId && path ? api.readSessionFile(sessionId, path) : null),
	);

	return {
		content: data?.content,
		encoding: data?.encoding,
		size: data?.size,
		isLoading,
		error,
		mutate,
	};
}

// Helper: Check if a directory has any changed descendants
export function hasChangedDescendant(
	dirPath: string,
	diffEntriesMap: Map<string, SessionDiffFileEntry>,
): boolean {
	const prefix = dirPath === "." ? "" : `${dirPath}/`;
	for (const path of diffEntriesMap.keys()) {
		if (path.startsWith(prefix)) return true;
	}
	return false;
}

// Helper: Convert API file entries to LazyFileNodes
export function entriesToNodes(
	entries: SessionFileEntry[],
	parentPath: string,
	diffEntriesMap: Map<string, SessionDiffFileEntry>,
): LazyFileNode[] {
	// Convert existing filesystem entries
	const existingPaths = new Set(
		entries.map((e) =>
			parentPath === "." ? e.name : `${parentPath}/${e.name}`,
		),
	);

	const nodes: LazyFileNode[] = entries.map((entry) => {
		const path =
			parentPath === "." ? entry.name : `${parentPath}/${entry.name}`;
		const isDir = entry.type === "directory";
		const diffEntry = diffEntriesMap.get(path);

		return {
			name: entry.name,
			path,
			type: entry.type,
			size: entry.size,
			children: isDir ? undefined : undefined,
			// Mark as changed if file is changed, or if directory has changed descendants
			changed: isDir
				? hasChangedDescendant(path, diffEntriesMap)
				: diffEntry !== undefined,
			// Include status for files
			status: isDir ? undefined : diffEntry?.status,
		};
	});

	// Add deleted files and ghost directories for deleted files not on filesystem
	const addedPaths = new Set<string>();
	for (const [filePath, diffEntry] of diffEntriesMap) {
		if (diffEntry.status !== "deleted") continue;

		// Check if this deleted file is under parentPath
		const isDirectChild = (() => {
			const parentDir = filePath.includes("/")
				? filePath.substring(0, filePath.lastIndexOf("/"))
				: ".";
			return parentDir === parentPath;
		})();

		const isUnderParent =
			parentPath === "." ? true : filePath.startsWith(`${parentPath}/`);

		if (!isUnderParent) continue;

		if (isDirectChild) {
			// Direct child - add the deleted file
			if (existingPaths.has(filePath) || addedPaths.has(filePath)) continue;

			const name = filePath.split("/").pop() || filePath;
			nodes.push({
				name,
				path: filePath,
				type: "file",
				changed: true,
				status: "deleted",
			});
			addedPaths.add(filePath);
		} else {
			// Nested under a subdirectory - may need to create ghost directory
			const relativePath =
				parentPath === "."
					? filePath
					: filePath.substring(parentPath.length + 1);
			const firstPart = relativePath.split("/")[0];
			const ghostDirPath =
				parentPath === "." ? firstPart : `${parentPath}/${firstPart}`;

			if (existingPaths.has(ghostDirPath) || addedPaths.has(ghostDirPath))
				continue;

			// Create ghost directory for deleted files
			nodes.push({
				name: firstPart,
				path: ghostDirPath,
				type: "directory",
				changed: true,
				children: undefined, // Will be populated when expanded
			});
			addedPaths.add(ghostDirPath);
		}
	}

	// Sort: directories first, then alphabetically
	return nodes.sort((a, b) => {
		if (a.type !== b.type) {
			return a.type === "directory" ? -1 : 1;
		}
		return a.name.localeCompare(b.name);
	});
}

// Helper: Build full tree from root nodes and cached children
function buildTreeFromCache(
	rootNodes: LazyFileNode[],
	cache: Map<string, LazyFileNode[]>,
	diffEntriesMap: Map<string, SessionDiffFileEntry>,
): LazyFileNode[] {
	function attachChildren(node: LazyFileNode): LazyFileNode {
		if (node.type !== "directory") return node;

		const cachedChildren = cache.get(node.path);
		if (!cachedChildren) return node;

		return {
			...node,
			children: cachedChildren.map((child) => {
				const isDir = child.type === "directory";
				const diffEntry = diffEntriesMap.get(child.path);
				return {
					...attachChildren(child),
					changed: isDir
						? hasChangedDescendant(child.path, diffEntriesMap)
						: diffEntry !== undefined,
					status: isDir ? undefined : diffEntry?.status,
				};
			}),
		};
	}

	return rootNodes.map((node) => {
		const isDir = node.type === "directory";
		const diffEntry = diffEntriesMap.get(node.path);
		return {
			...attachChildren(node),
			changed: isDir
				? hasChangedDescendant(node.path, diffEntriesMap)
				: diffEntry !== undefined,
			status: isDir ? undefined : diffEntry?.status,
		};
	});
}

// Helper: Build a minimal tree structure from just the changed files
function buildTreeFromChangedFiles(
	diffEntries: SessionDiffFileEntry[],
): LazyFileNode[] {
	if (diffEntries.length === 0) return [];

	// Build a map for quick status lookup
	const statusMap = new Map<string, FileStatus>();
	for (const entry of diffEntries) {
		statusMap.set(entry.path, entry.status);
	}

	// Build a nested map structure from file paths
	interface TreeNode {
		children: Map<string, TreeNode>;
		isFile: boolean;
	}

	const root: TreeNode = { children: new Map(), isFile: false };

	for (const entry of diffEntries) {
		const parts = entry.path.split("/");
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;

			if (!current.children.has(part)) {
				current.children.set(part, {
					children: new Map(),
					isFile: isLast,
				});
			}
			const next = current.children.get(part);
			if (!next) {
				continue;
			}
			current = next;
			if (isLast) {
				current.isFile = true;
			}
		}
	}

	// Convert the map structure to LazyFileNode array
	function convertToNodes(node: TreeNode, parentPath: string): LazyFileNode[] {
		const nodes: LazyFileNode[] = [];

		for (const [name, child] of node.children) {
			const path = parentPath === "." ? name : `${parentPath}/${name}`;
			const isDir = !child.isFile || child.children.size > 0;
			const status = statusMap.get(path);

			nodes.push({
				name,
				path,
				type: isDir ? "directory" : "file",
				children: isDir ? convertToNodes(child, path) : undefined,
				// Directories in this tree always have changed descendants (that's how they're built)
				// Files are changed if they're in the changed files list
				changed: isDir ? true : child.isFile,
				// Include status for files
				status: isDir ? undefined : status,
			});
		}

		// Sort: directories first, then alphabetically
		return nodes.sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === "directory" ? -1 : 1;
			}
			return a.name.localeCompare(b.name);
		});
	}

	return convertToNodes(root, ".");
}
