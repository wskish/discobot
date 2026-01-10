"use client";

import useSWR from "swr";
import { api } from "../api-client";

export function useSessionFiles(sessionId: string | null) {
	const { data, error, isLoading, mutate } = useSWR(
		sessionId ? `files-${sessionId}` : null,
		() => (sessionId ? api.getSessionFiles(sessionId) : []),
	);

	return {
		files: data || [],
		isLoading,
		error,
		mutate,
	};
}

export function useFile(fileId: string | null) {
	const { data, error, isLoading } = useSWR(
		fileId ? `file-${fileId}` : null,
		() => (fileId ? api.getFile(fileId) : null),
	);

	return {
		file: data,
		isLoading,
		error,
	};
}
