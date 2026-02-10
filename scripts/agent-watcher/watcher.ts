/**
 * Agent Watcher Module
 *
 * Core logic for watching the agent directory and root Dockerfile,
 * triggering Docker builds when changes are detected.
 */

import { spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { access, constants, readFile, writeFile } from "node:fs/promises";

export interface WatcherConfig {
	/** Primary agent directory (agent-api) */
	agentDir: string;
	/** Additional directories to watch (e.g., agent init process) */
	additionalDirs?: string[];
	/** Project root directory (where Dockerfile lives) */
	projectRoot: string;
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
	private watchers: FSWatcher[] = [];
	private dockerfileWatcher: FSWatcher | null = null;
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
			this.config.projectRoot,
		);

		if (result.exitCode !== 0) {
			this.logger.error("Docker build failed:");
			this.logger.error(result.stderr || result.stdout);
			return null;
		}

		this.logger.success("Docker build succeeded");

		// Get the image ID to use as a stable tag
		const inspectResult = await this.runCommand(
			"docker",
			["inspect", "--format={{.Id}}", this.imageRef],
			this.config.projectRoot,
		);

		if (inspectResult.exitCode !== 0) {
			this.logger.error("Failed to inspect image:");
			this.logger.error(inspectResult.stderr || inspectResult.stdout);
			return null;
		}

		// Extract the first 8 characters of the image ID (after "sha256:")
		const imageId = inspectResult.stdout.trim();
		const shortId = imageId.replace(/^sha256:/, "").slice(0, 8);

		// Create a tag with discobot-local/ prefix using the short image ID
		// This allows the image to be recognized as a local build and ensures
		// the tag is stable for the same image content
		const localImageRef = `discobot-local/${this.config.imageName}:${shortId}`;

		// Tag the image with the ID-based reference
		const tagResult = await this.runCommand(
			"docker",
			["tag", this.imageRef, localImageRef],
			this.config.projectRoot,
		);

		if (tagResult.exitCode !== 0) {
			this.logger.error("Failed to tag image:");
			this.logger.error(tagResult.stderr || tagResult.stdout);
			return null;
		}

		this.logger.log(`Tagged as: ${localImageRef}`);
		return localImageRef;
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

		// If a build is in progress, mark that we need to rebuild when it completes.
		// This ensures changes aren't missed if the debounce timer hasn't fired yet
		// when the current build finishes.
		if (this.buildInProgress) {
			this.pendingBuild = true;
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

		// Collect all directories to watch
		const dirsToWatch = [this.config.agentDir];
		if (this.config.additionalDirs) {
			dirsToWatch.push(...this.config.additionalDirs);
		}

		for (const dir of dirsToWatch) {
			this.logger.log(`Watching ${dir} for changes`);
		}

		// Do an initial build
		this.logger.log("Performing initial build...");
		await this.doBuild();

		// Watch for changes in all directories
		for (const dir of dirsToWatch) {
			const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
				if (shouldIgnorePath(filename)) {
					return;
				}

				this.logger.log(`Change detected: ${filename} (${eventType})`);
				this.onFileChange?.(filename ?? "", eventType);
				this.scheduleBuild();
			});

			watcher.on("error", (err) => {
				this.logger.error(`Watcher error for ${dir}: ${err}`);
			});

			watcher.on("close", () => {
				this.logger.error(`Watcher for ${dir} closed unexpectedly!`);
			});

			this.watchers.push(watcher);
		}

		// Watch for changes to Dockerfile at project root
		// Note: We watch the directory instead of the file directly because
		// fs.watch() on a single file is unreliable on many platforms (especially WSL2).
		// The watcher can silently stop working after certain filesystem operations.
		this.logger.log(
			`Watching ${this.config.projectRoot} for Dockerfile changes`,
		);

		this.dockerfileWatcher = watch(
			this.config.projectRoot,
			(eventType, filename) => {
				if (filename !== "Dockerfile") {
					return;
				}
				this.logger.log(`Dockerfile changed (${eventType})`);
				this.onFileChange?.(filename, eventType);
				this.scheduleBuild();
			},
		);

		this.dockerfileWatcher.on("error", (err) => {
			this.logger.error(`Dockerfile watcher error: ${err}`);
		});

		this.dockerfileWatcher.on("close", () => {
			this.logger.error("Dockerfile watcher closed unexpectedly!");
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
		for (const watcher of this.watchers) {
			watcher.close();
		}
		this.watchers = [];
		if (this.dockerfileWatcher) {
			this.dockerfileWatcher.close();
			this.dockerfileWatcher = null;
		}
	}
}
