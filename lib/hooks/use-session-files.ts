"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { api } from "../api-client";
import type {
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
	/** Whether this file has been modified in the session */
	changed?: boolean;
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
	const { data: diffData, isLoading: isLoadingDiff } = useSWR(
		sessionId ? `session-diff-${sessionId}-files` : null,
		async () => {
			if (!sessionId) return null;
			const result = await api.getSessionDiff(sessionId, { format: "files" });
			return result as SessionDiffFilesResponse;
		},
	);

	// Convert API response to LazyFileNode tree, or build from changed files only
	const rootNodes = useMemo(() => {
		if (loadAllFiles) {
			if (!rootData) return [];
			return entriesToNodes(rootData.entries, ".", diffData?.files);
		}
		// Build minimal tree from changed files only
		return buildTreeFromChangedFiles(diffData?.files || []);
	}, [rootData, diffData?.files, loadAllFiles]);

	// Build tree from root nodes and cached children
	const fileTree = useMemo(() => {
		return buildTreeFromCache(rootNodes, childrenCache, diffData?.files);
	}, [rootNodes, childrenCache, diffData?.files]);

	// Expand a directory (triggers lazy load)
	const expandDirectory = useCallback(
		async (path: string) => {
			if (!sessionId) return;

			// Add to expanded set
			setExpandedPaths((prev) => new Set(prev).add(path));

			// If already cached or loading, don't fetch again
			if (childrenCache.has(path) || loadingPaths.has(path)) return;

			// Start loading
			setLoadingPaths((prev) => new Set(prev).add(path));

			try {
				const data = await api.listSessionFiles(sessionId, path);
				const nodes = entriesToNodes(data.entries, path, diffData?.files);
				setChildrenCache((prev) => new Map(prev).set(path, nodes));
			} finally {
				setLoadingPaths((prev) => {
					const next = new Set(prev);
					next.delete(path);
					return next;
				});
			}
		},
		[sessionId, childrenCache, loadingPaths, diffData?.files],
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

	// Refresh files (clear cache and reload)
	const refresh = useCallback(() => {
		setChildrenCache(new Map());
		setExpandedPaths(new Set(["."]));
	}, []);

	// Check if a path is loading
	const isPathLoading = useCallback(
		(path: string) => loadingPaths.has(path),
		[loadingPaths],
	);

	return {
		fileTree,
		isLoading: isLoadingRoot || isLoadingDiff,
		diffStats: diffData?.stats,
		changedFiles: diffData?.files || [],
		expandedPaths,
		expandDirectory,
		collapseDirectory,
		toggleDirectory,
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

// Helper: Convert API file entries to LazyFileNodes
function entriesToNodes(
	entries: SessionFileEntry[],
	parentPath: string,
	changedFiles?: string[],
): LazyFileNode[] {
	const changedSet = new Set(changedFiles || []);

	return entries.map((entry) => {
		const path =
			parentPath === "." ? entry.name : `${parentPath}/${entry.name}`;
		return {
			name: entry.name,
			path,
			type: entry.type,
			size: entry.size,
			children: entry.type === "directory" ? undefined : undefined,
			changed: changedSet.has(path),
		};
	});
}

// Helper: Build full tree from root nodes and cached children
function buildTreeFromCache(
	rootNodes: LazyFileNode[],
	cache: Map<string, LazyFileNode[]>,
	changedFiles?: string[],
): LazyFileNode[] {
	const changedSet = new Set(changedFiles || []);

	function attachChildren(node: LazyFileNode): LazyFileNode {
		if (node.type !== "directory") return node;

		const cachedChildren = cache.get(node.path);
		if (!cachedChildren) return node;

		return {
			...node,
			children: cachedChildren.map((child) => ({
				...attachChildren(child),
				changed: changedSet.has(child.path),
			})),
		};
	}

	return rootNodes.map((node) => ({
		...attachChildren(node),
		changed: changedSet.has(node.path),
	}));
}

// Helper: Build a minimal tree structure from just the changed file paths
function buildTreeFromChangedFiles(changedFiles: string[]): LazyFileNode[] {
	if (changedFiles.length === 0) return [];

	// Build a nested map structure from file paths
	interface TreeNode {
		children: Map<string, TreeNode>;
		isFile: boolean;
	}

	const root: TreeNode = { children: new Map(), isFile: false };

	for (const filePath of changedFiles) {
		const parts = filePath.split("/");
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
			current = current.children.get(part)!;
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

			nodes.push({
				name,
				path,
				type: isDir ? "directory" : "file",
				children: isDir ? convertToNodes(child, path) : undefined,
				changed: child.isFile,
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
