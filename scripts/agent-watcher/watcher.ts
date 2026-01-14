/**
 * Agent Watcher Module
 *
 * Core logic for watching the agent directory and triggering Docker builds.
 */

import { spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { access, constants, readFile, writeFile } from "node:fs/promises";

export interface WatcherConfig {
	agentDir: string;
	envFilePath: string;
	imageName: string;
	imageTag: string;
	debounceMs: number;
	/** Optional: custom command runner for testing */
	runCommand?: CommandRunner;
	/** Optional: custom logger */
	logger?: Logger;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type CommandRunner = (
	command: string,
	args: string[],
	cwd: string,
) => Promise<CommandResult>;

export interface Logger {
	log: (message: string) => void;
	error: (message: string) => void;
	success: (message: string) => void;
}

/** Default command runner using child_process.spawn */
export async function defaultRunCommand(
	command: string,
	args: string[],
	cwd: string,
): Promise<CommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 1 });
		});

		proc.on("error", (err) => {
			stderr += err.message;
			resolve({ stdout, stderr, exitCode: 1 });
		});
	});
}

/** Default console logger with colors */
export function createDefaultLogger(): Logger {
	return {
		log: (message: string) => {
			const timestamp = new Date().toISOString().slice(11, 19);
			console.log(`\x1b[36m[agent-watcher ${timestamp}]\x1b[0m ${message}`);
		},
		error: (message: string) => {
			const timestamp = new Date().toISOString().slice(11, 19);
			console.error(`\x1b[31m[agent-watcher ${timestamp}]\x1b[0m ${message}`);
		},
		success: (message: string) => {
			const timestamp = new Date().toISOString().slice(11, 19);
			console.log(`\x1b[32m[agent-watcher ${timestamp}]\x1b[0m ${message}`);
		},
	};
}

/**
 * Updates an env file with the SANDBOX_IMAGE variable.
 * Creates the file if it doesn't exist.
 * Replaces existing SANDBOX_IMAGE if present, otherwise appends.
 */
export async function updateEnvFile(
	envFilePath: string,
	imageRef: string,
): Promise<boolean> {
	let envContent = "";

	try {
		await access(envFilePath, constants.F_OK);
		envContent = await readFile(envFilePath, "utf-8");
	} catch {
		// File doesn't exist, create it
		envContent = "";
	}

	const lines = envContent.split("\n");
	let found = false;
	const newLines = lines.map((line) => {
		if (line.startsWith("SANDBOX_IMAGE=")) {
			found = true;
			return `SANDBOX_IMAGE=${imageRef}`;
		}
		return line;
	});

	if (!found) {
		// Remove trailing empty lines and add the new var
		while (newLines.length > 0 && newLines[newLines.length - 1] === "") {
			newLines.pop();
		}
		newLines.push(`SANDBOX_IMAGE=${imageRef}`);
		newLines.push(""); // End with newline
	}

	const newContent = newLines.join("\n");

	try {
		await writeFile(envFilePath, newContent, "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * Checks if a path should be ignored by the watcher.
 */
export function shouldIgnorePath(filename: string | null): boolean {
	if (!filename) return true;
	return (
		filename.includes("node_modules") ||
		filename.startsWith(".") ||
		filename.includes("/.")
	);
}

export class AgentWatcher {
	private config: WatcherConfig;
	private runCommand: CommandRunner;
	private logger: Logger;
	private watcher: FSWatcher | null = null;
	private buildInProgress = false;
	private pendingBuild = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** Event callbacks for testing */
	public onBuildStart?: () => void;
	public onBuildComplete?: (success: boolean, imageRef: string | null) => void;
	public onEnvUpdate?: (imageRef: string) => void;
	public onFileChange?: (filename: string, eventType: string) => void;

	constructor(config: WatcherConfig) {
		this.config = config;
		this.runCommand = config.runCommand ?? defaultRunCommand;
		this.logger = config.logger ?? createDefaultLogger();
	}

	get imageRef(): string {
		return `${this.config.imageName}:${this.config.imageTag}`;
	}

	async checkAgentDirExists(): Promise<boolean> {
		try {
			await access(this.config.agentDir, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async buildImage(): Promise<string | null> {
		this.logger.log(`Building Docker image ${this.imageRef}...`);

		const result = await this.runCommand(
			"docker",
			["build", "-t", this.imageRef, "."],
			this.config.agentDir,
		);

		if (result.exitCode !== 0) {
			this.logger.error("Docker build failed:");
			this.logger.error(result.stderr || result.stdout);
			return null;
		}

		this.logger.success("Docker build succeeded");

		// Get the image ID (sha256 digest) for deterministic references
		const digestResult = await this.runCommand(
			"docker",
			["inspect", this.imageRef, "--format", "{{.Id}}"],
			this.config.agentDir,
		);

		if (digestResult.exitCode !== 0 || !digestResult.stdout.trim()) {
			this.logger.error("Failed to get image digest:");
			this.logger.error(digestResult.stderr || digestResult.stdout);
			// Fall back to tag-based reference
			return this.imageRef;
		}

		const imageId = digestResult.stdout.trim();
		this.logger.log(`Image ID: ${imageId}`);
		return imageId;
	}

	async updateEnv(imageRef: string): Promise<boolean> {
		const success = await updateEnvFile(this.config.envFilePath, imageRef);
		if (success) {
			this.logger.success(
				`Updated ${this.config.envFilePath} with SANDBOX_IMAGE=${imageRef}`,
			);
			this.onEnvUpdate?.(imageRef);
		} else {
			this.logger.error(`Failed to write ${this.config.envFilePath}`);
		}
		return success;
	}

	async doBuild(): Promise<void> {
		if (this.buildInProgress) {
			this.pendingBuild = true;
			return;
		}

		this.buildInProgress = true;
		this.pendingBuild = false;
		this.onBuildStart?.();

		try {
			const imageRef = await this.buildImage();
			if (!imageRef) {
				this.onBuildComplete?.(false, null);
				return;
			}

			// Use the image ID (sha256 digest) for deterministic container creation
			await this.updateEnv(imageRef);

			this.logger.log(
				"Image ready. Server will use the new image for new containers.",
			);
			this.onBuildComplete?.(true, imageRef);
		} finally {
			this.buildInProgress = false;

			if (this.pendingBuild) {
				this.logger.log("Processing pending build request...");
				this.doBuild();
			}
		}
	}

	scheduleBuild(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.doBuild();
		}, this.config.debounceMs);
	}

	async start(): Promise<void> {
		this.logger.log("Starting agent image watcher...");

		if (!(await this.checkAgentDirExists())) {
			this.logger.error(`Agent directory not found: ${this.config.agentDir}`);
			throw new Error(`Agent directory not found: ${this.config.agentDir}`);
		}

		this.logger.log(`Watching ${this.config.agentDir} for changes`);

		// Do an initial build
		this.logger.log("Performing initial build...");
		await this.doBuild();

		// Watch for changes
		this.watcher = watch(
			this.config.agentDir,
			{ recursive: true },
			(eventType, filename) => {
				if (shouldIgnorePath(filename)) {
					return;
				}

				this.logger.log(`Change detected: ${filename} (${eventType})`);
				this.onFileChange?.(filename ?? "", eventType);
				this.scheduleBuild();
			},
		);

		this.watcher.on("error", (err) => {
			this.logger.error(`Watcher error: ${err}`);
		});

		// Handle graceful shutdown
		const shutdown = () => {
			this.logger.log("Shutting down...");
			this.stop();
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		this.logger.log("Watcher ready. Press Ctrl+C to stop.");
	}

	stop(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
	}
}
