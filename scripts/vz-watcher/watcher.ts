/**
 * VZ Image Watcher Module
 *
 * Watches the Dockerfile and vm-assets directory, builds the VZ Docker target,
 * extracts kernel + squashfs, decompresses the kernel for Apple VZ, and
 * updates server/.env with VZ_KERNEL_PATH and VZ_BASE_DISK_PATH.
 */

import { spawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	type FSWatcher,
	watch,
} from "node:fs";
import {
	access,
	constants,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export interface VzWatcherConfig {
	/** Project root directory (where Dockerfile lives) */
	projectRoot: string;
	/** Directories to watch for changes */
	watchDirs: string[];
	/** Path to server/.env */
	envFilePath: string;
	/** Output directory for extracted files */
	outputDir: string;
	/** Debounce interval in ms */
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
			// Stream build output to console for progress visibility
			process.stderr.write(data);
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
			console.log(`\x1b[36m[vz-watcher ${timestamp}]\x1b[0m ${message}`);
		},
		error: (message: string) => {
			const timestamp = new Date().toISOString().slice(11, 19);
			console.error(`\x1b[31m[vz-watcher ${timestamp}]\x1b[0m ${message}`);
		},
		success: (message: string) => {
			const timestamp = new Date().toISOString().slice(11, 19);
			console.log(`\x1b[32m[vz-watcher ${timestamp}]\x1b[0m ${message}`);
		},
	};
}

/**
 * Checks if a file is gzip-compressed by reading its magic bytes.
 */
async function isGzipped(filePath: string): Promise<boolean> {
	const fd = await readFile(filePath);
	return fd.length >= 2 && fd[0] === 0x1f && fd[1] === 0x8b;
}

/**
 * Decompresses a gzip file to a destination path.
 * Uses a temp file + atomic rename to avoid partial writes.
 */
async function gunzipFile(src: string, dest: string): Promise<void> {
	const tmp = `${dest}.tmp`;
	await pipeline(createReadStream(src), createGunzip(), createWriteStream(tmp));
	await rename(tmp, dest);
}

/**
 * Updates env file with VZ_KERNEL_PATH and VZ_BASE_DISK_PATH.
 * Creates the file if it doesn't exist.
 */
export async function updateEnvFile(
	envFilePath: string,
	vars: Record<string, string>,
): Promise<boolean> {
	let envContent = "";

	try {
		await access(envFilePath, constants.F_OK);
		envContent = await readFile(envFilePath, "utf-8");
	} catch {
		envContent = "";
	}

	const lines = envContent.split("\n");

	for (const [key, value] of Object.entries(vars)) {
		let found = false;
		for (let i = 0; i < lines.length; i++) {
			// Match both active and commented-out versions
			if (lines[i].startsWith(`${key}=`) || lines[i] === `#${key}=`) {
				lines[i] = `${key}=${value}`;
				found = true;
				break;
			}
		}

		if (!found) {
			// Remove trailing empty lines and append
			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}
			lines.push(`${key}=${value}`);
		}
	}

	// Ensure trailing newline
	if (lines[lines.length - 1] !== "") {
		lines.push("");
	}

	try {
		await writeFile(envFilePath, lines.join("\n"), "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Checks if a path should be ignored by the watcher. */
function shouldIgnorePath(filename: string | null): boolean {
	if (!filename) return true;
	return (
		filename.includes("node_modules") ||
		filename.startsWith(".") ||
		filename.includes("/.")
	);
}

export class VzWatcher {
	private config: VzWatcherConfig;
	private runCommand: CommandRunner;
	private logger: Logger;
	private watchers: FSWatcher[] = [];
	private dockerfileWatcher: FSWatcher | null = null;
	private buildInProgress = false;
	private pendingBuild = false;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** Event callbacks for testing */
	public onBuildStart?: () => void;
	public onBuildComplete?: (success: boolean) => void;

	constructor(config: VzWatcherConfig) {
		this.config = config;
		this.runCommand = config.runCommand ?? defaultRunCommand;
		this.logger = config.logger ?? createDefaultLogger();
	}

	/**
	 * Builds the VZ image using Docker buildx and extracts output files.
	 * Uses --output type=local to extract vmlinuz + squashfs directly.
	 */
	async buildImage(): Promise<boolean> {
		this.logger.log("Building VZ image (docker build --target vz-image)...");

		// Ensure output directory exists
		await mkdir(this.config.outputDir, { recursive: true });

		const result = await this.runCommand(
			"docker",
			[
				"build",
				"--target",
				"vz-image",
				"--output",
				`type=local,dest=${this.config.outputDir}`,
				".",
			],
			this.config.projectRoot,
		);

		if (result.exitCode !== 0) {
			this.logger.error("VZ image build failed:");
			this.logger.error(result.stderr || result.stdout);
			return false;
		}

		this.logger.success("VZ image build succeeded");
		return true;
	}

	/**
	 * Decompresses the kernel if it's gzip-compressed.
	 * Apple Virtualization.framework requires an uncompressed kernel.
	 */
	async decompressKernel(): Promise<string> {
		const compressedPath = join(this.config.outputDir, "vmlinuz");
		const decompressedPath = join(this.config.outputDir, "vmlinux");

		try {
			await access(compressedPath, constants.F_OK);
		} catch {
			throw new Error(`Kernel not found at ${compressedPath}`);
		}

		if (await isGzipped(compressedPath)) {
			this.logger.log("Decompressing kernel (gzip → vmlinux)...");
			await gunzipFile(compressedPath, decompressedPath);
			await unlink(compressedPath);
			this.logger.success("Kernel decompressed");
			return decompressedPath;
		}

		this.logger.log("Kernel is already uncompressed");
		// Rename to vmlinux for consistency
		await rename(compressedPath, decompressedPath);
		return decompressedPath;
	}

	/**
	 * Updates server/.env with the paths to extracted VZ files.
	 */
	async updateEnv(kernelPath: string, baseDiskPath: string): Promise<boolean> {
		const success = await updateEnvFile(this.config.envFilePath, {
			VZ_KERNEL_PATH: kernelPath,
			VZ_BASE_DISK_PATH: baseDiskPath,
		});

		if (success) {
			this.logger.success(
				`Updated ${this.config.envFilePath}:\n` +
					`  VZ_KERNEL_PATH=${kernelPath}\n` +
					`  VZ_BASE_DISK_PATH=${baseDiskPath}`,
			);
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
			// Build the VZ image and extract files
			if (!(await this.buildImage())) {
				this.onBuildComplete?.(false);
				return;
			}

			// Decompress kernel for Apple VZ
			const kernelPath = await this.decompressKernel();
			const baseDiskPath = join(
				this.config.outputDir,
				"discobot-rootfs.squashfs",
			);

			// Verify squashfs exists
			try {
				await access(baseDiskPath, constants.F_OK);
			} catch {
				this.logger.error(`SquashFS rootfs not found at ${baseDiskPath}`);
				this.onBuildComplete?.(false);
				return;
			}

			// Update .env
			await this.updateEnv(kernelPath, baseDiskPath);

			this.logger.log(
				"VZ image ready. Restart server to use the new kernel and rootfs.",
			);
			this.onBuildComplete?.(true);
		} catch (err) {
			this.logger.error(`Build failed: ${err}`);
			this.onBuildComplete?.(false);
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

		if (this.buildInProgress) {
			this.pendingBuild = true;
		}

		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.doBuild();
		}, this.config.debounceMs);
	}

	async start(): Promise<void> {
		this.logger.log("Starting VZ image watcher...");

		// Watch vm-assets and other directories
		for (const dir of this.config.watchDirs) {
			try {
				await access(dir, constants.F_OK);
			} catch {
				this.logger.error(`Watch directory not found: ${dir}`);
				throw new Error(`Watch directory not found: ${dir}`);
			}

			this.logger.log(`Watching ${dir} for changes`);

			const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
				if (shouldIgnorePath(filename)) return;
				this.logger.log(`Change detected: ${filename} (${eventType})`);
				this.scheduleBuild();
			});

			watcher.on("error", (err) => {
				this.logger.error(`Watcher error for ${dir}: ${err}`);
			});

			this.watchers.push(watcher);
		}

		// Watch Dockerfile at project root
		this.logger.log(
			`Watching ${this.config.projectRoot} for Dockerfile changes`,
		);

		this.dockerfileWatcher = watch(
			this.config.projectRoot,
			(eventType, filename) => {
				if (filename !== "Dockerfile") return;
				this.logger.log(`Dockerfile changed (${eventType})`);
				this.scheduleBuild();
			},
		);

		this.dockerfileWatcher.on("error", (err) => {
			this.logger.error(`Dockerfile watcher error: ${err}`);
		});

		// Do initial build
		this.logger.log("Performing initial build...");
		await this.doBuild();

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
