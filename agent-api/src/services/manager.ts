/**
 * Service Manager
 *
 * Manages service process lifecycle with file-based output storage.
 * Handles starting, stopping, and tracking service processes.
 * Output is persisted to ~/.config/discobot/services/output/{id}.out
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type {
	Service,
	ServiceAlreadyRunningResponse,
	ServiceNotFoundResponse,
	ServiceNotRunningResponse,
	ServiceOutputEvent,
	StartServiceResponse,
	StopServiceResponse,
} from "../api/types.js";
import {
	appendEvent,
	clearOutput,
	createErrorEvent,
	createExitEvent,
	createStderrEvent,
	createStdoutEvent,
	readEvents,
	truncateIfNeeded,
} from "./output.js";
import { discoverServices } from "./parser.js";

/**
 * Internal state for a managed service
 */
export interface ManagedService {
	service: Service;
	process: ChildProcess;
	eventEmitter: EventEmitter;
}

/**
 * In-memory store for running/recently-stopped services
 */
const runningServices: Map<string, ManagedService> = new Map();

/**
 * Grace period to keep stopped services in memory (30 seconds)
 */
const STOPPED_SERVICE_GRACE_PERIOD = 30000;

/**
 * Services directory name
 */
const SERVICES_DIR = ".discobot/services";

// ============================================================================
// Result Types
// ============================================================================

export type StartServiceResult =
	| { ok: true; status: 202; response: StartServiceResponse }
	| { ok: false; status: 404; response: ServiceNotFoundResponse }
	| { ok: false; status: 409; response: ServiceAlreadyRunningResponse };

export type StopServiceResult =
	| { ok: true; status: 200; response: StopServiceResponse }
	| { ok: false; status: 404; response: ServiceNotFoundResponse }
	| { ok: false; status: 400; response: ServiceNotRunningResponse };

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all services (discovered + runtime state)
 */
export async function getServices(workspaceRoot: string): Promise<Service[]> {
	const servicesDir = join(workspaceRoot, SERVICES_DIR);
	const discoveredServices = await discoverServices(servicesDir);

	// Merge with runtime state
	return discoveredServices.map((service) => {
		const managed = runningServices.get(service.id);
		if (managed) {
			return { ...managed.service };
		}
		return service;
	});
}

/**
 * Get a single service by ID.
 * Service IDs are normalized to lowercase, so lookups are exact match.
 */
export async function getService(
	workspaceRoot: string,
	serviceId: string,
): Promise<Service | null> {
	// Check running services first
	const managed = runningServices.get(serviceId);
	if (managed) {
		return { ...managed.service };
	}

	// Fall back to discovery
	const services = await getServices(workspaceRoot);
	return services.find((s) => s.id === serviceId) || null;
}

/**
 * Get managed service state (for output streaming)
 */
export function getManagedService(
	serviceId: string,
): ManagedService | undefined {
	return runningServices.get(serviceId);
}

/**
 * Start a service by ID
 */
export async function startService(
	workspaceRoot: string,
	serviceId: string,
): Promise<StartServiceResult> {
	// Check if already running
	const existing = runningServices.get(serviceId);
	if (existing && existing.service.status === "running") {
		return {
			ok: false,
			status: 409,
			response: {
				error: "service_already_running",
				serviceId,
				pid: existing.process.pid || 0,
			},
		};
	}

	// Discover the service
	const servicesDir = join(workspaceRoot, SERVICES_DIR);
	const services = await discoverServices(servicesDir);
	const serviceTemplate = services.find((s) => s.id === serviceId);

	if (!serviceTemplate) {
		return {
			ok: false,
			status: 404,
			response: {
				error: "service_not_found",
				serviceId,
			},
		};
	}

	// Clear previous output and spawn the process
	await clearOutput(serviceId);
	spawnService(workspaceRoot, serviceTemplate);

	return {
		ok: true,
		status: 202,
		response: {
			status: "starting",
			serviceId,
		},
	};
}

/**
 * Stop a service by ID
 */
export async function stopService(
	serviceId: string,
): Promise<StopServiceResult> {
	const managed = runningServices.get(serviceId);

	if (!managed) {
		return {
			ok: false,
			status: 404,
			response: {
				error: "service_not_found",
				serviceId,
			},
		};
	}

	if (
		managed.service.status !== "running" &&
		managed.service.status !== "starting"
	) {
		return {
			ok: false,
			status: 400,
			response: {
				error: "service_not_running",
				serviceId,
			},
		};
	}

	// Update status
	managed.service.status = "stopping";

	// Kill the entire process group (including all child processes)
	const pid = managed.process.pid;
	if (pid) {
		try {
			// Negative PID kills the entire process group
			process.kill(-pid, "SIGTERM");
		} catch (err) {
			// Process may have already exited
			console.error(`Failed to send SIGTERM to process group ${pid}:`, err);
		}

		// Force kill after 5 seconds if still running
		setTimeout(() => {
			if (managed.service.status === "stopping") {
				try {
					process.kill(-pid, "SIGKILL");
				} catch (err) {
					// Process group may have already exited
					console.error(`Failed to send SIGKILL to process group ${pid}:`, err);
				}
			}
		}, 5000);
	}

	return {
		ok: true,
		status: 200,
		response: {
			status: "stopped",
			serviceId,
		},
	};
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Spawn a service process and set up event handlers
 */
function spawnService(workspaceRoot: string, serviceTemplate: Service): void {
	const eventEmitter = new EventEmitter();

	const service: Service = {
		...serviceTemplate,
		status: "starting",
		startedAt: new Date().toISOString(),
	};

	// Spawn the process in its own process group (detached)
	// This allows us to kill the entire process tree later
	const proc = spawn(serviceTemplate.path, [], {
		cwd: workspaceRoot,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env },
		detached: true,
	});

	service.pid = proc.pid;

	const managed: ManagedService = {
		service,
		process: proc,
		eventEmitter,
	};

	runningServices.set(service.id, managed);

	// Helper to write event to file and emit
	const emitEvent = async (event: ServiceOutputEvent) => {
		try {
			await appendEvent(service.id, event);
			// Periodically check if truncation needed
			if (Math.random() < 0.01) {
				await truncateIfNeeded(service.id);
			}
		} catch (err) {
			console.error(`Failed to write service output for ${service.id}:`, err);
		}
		eventEmitter.emit("output", event);
	};

	// Handle stdout
	proc.stdout?.on("data", (data: Buffer) => {
		const event = createStdoutEvent(data.toString());
		emitEvent(event);
	});

	// Handle stderr
	proc.stderr?.on("data", (data: Buffer) => {
		const event = createStderrEvent(data.toString());
		emitEvent(event);
	});

	// Mark as running once spawn succeeds
	proc.on("spawn", () => {
		service.status = "running";
	});

	// Handle exit
	proc.on("exit", (code) => {
		service.status = "stopped";
		service.exitCode = code ?? undefined;

		const event = createExitEvent(code);
		emitEvent(event).then(() => {
			eventEmitter.emit("close");
		});

		// Schedule cleanup after grace period
		setTimeout(() => {
			const current = runningServices.get(service.id);
			if (current && current.service.status === "stopped") {
				runningServices.delete(service.id);
			}
		}, STOPPED_SERVICE_GRACE_PERIOD);
	});

	// Handle spawn error
	proc.on("error", (err) => {
		service.status = "stopped";

		const event = createErrorEvent(err.message);
		emitEvent(event).then(() => {
			eventEmitter.emit("close");
		});
	});
}

/**
 * Get buffered output for a service (from file)
 */
export async function getServiceOutput(
	serviceId: string,
): Promise<ServiceOutputEvent[]> {
	return readEvents(serviceId);
}
