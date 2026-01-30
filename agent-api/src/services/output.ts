/**
 * Service Output Storage
 *
 * File-based output storage for service logs.
 * Events are written to ${HOME}/.config/discobot/services/output/${id}.out
 * in JSONL (newline-delimited JSON) format for easy streaming and replay.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceOutputEvent } from "../api/types.js";

/**
 * Output directory under user's config
 */
const OUTPUT_DIR = join(homedir(), ".config", "discobot", "services", "output");

/**
 * Maximum file size before truncation (1MB)
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Get the output file path for a service
 */
export function getOutputPath(serviceId: string): string {
	return join(OUTPUT_DIR, `${serviceId}.out`);
}

/**
 * Ensure the output directory exists
 */
async function ensureOutputDir(): Promise<void> {
	await mkdir(OUTPUT_DIR, { recursive: true });
}

/**
 * Append an event to the service's output file
 */
export async function appendEvent(
	serviceId: string,
	event: ServiceOutputEvent,
): Promise<void> {
	await ensureOutputDir();
	const filePath = getOutputPath(serviceId);
	const line = `${JSON.stringify(event)}\n`;
	await appendFile(filePath, line, "utf-8");
}

/**
 * Read all events from a service's output file
 */
export async function readEvents(
	serviceId: string,
): Promise<ServiceOutputEvent[]> {
	const filePath = getOutputPath(serviceId);

	try {
		const content = await readFile(filePath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		return lines.map((line) => JSON.parse(line) as ServiceOutputEvent);
	} catch (err) {
		// File doesn't exist yet
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw err;
	}
}

/**
 * Clear a service's output file (for fresh start)
 */
export async function clearOutput(serviceId: string): Promise<void> {
	await ensureOutputDir();
	const filePath = getOutputPath(serviceId);
	await writeFile(filePath, "", "utf-8");
}

/**
 * Truncate file if it exceeds max size (keeps last half)
 */
export async function truncateIfNeeded(serviceId: string): Promise<void> {
	const filePath = getOutputPath(serviceId);

	try {
		const stats = await stat(filePath);
		if (stats.size > MAX_FILE_SIZE) {
			// Read file and keep last half
			const content = await readFile(filePath, "utf-8");
			const lines = content.trim().split("\n");
			const keepLines = lines.slice(Math.floor(lines.length / 2));
			await writeFile(filePath, `${keepLines.join("\n")}\n`, "utf-8");
		}
	} catch (err) {
		// File doesn't exist, nothing to truncate
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
}

/**
 * Create a ServiceOutputEvent for stdout data
 */
export function createStdoutEvent(data: string): ServiceOutputEvent {
	return {
		type: "stdout",
		data,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a ServiceOutputEvent for stderr data
 */
export function createStderrEvent(data: string): ServiceOutputEvent {
	return {
		type: "stderr",
		data,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a ServiceOutputEvent for process exit
 */
export function createExitEvent(exitCode: number | null): ServiceOutputEvent {
	return {
		type: "exit",
		exitCode: exitCode ?? undefined,
		timestamp: new Date().toISOString(),
	};
}

/**
 * Create a ServiceOutputEvent for errors
 */
export function createErrorEvent(error: string): ServiceOutputEvent {
	return {
		type: "error",
		error,
		timestamp: new Date().toISOString(),
	};
}
