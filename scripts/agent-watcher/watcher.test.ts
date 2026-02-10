import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	AgentWatcher,
	type CommandRunner,
	type Logger,
	shouldIgnorePath,
	updateEnvFile,
} from "./watcher.js";

// Helper to create a temp directory
async function createTempDir(): Promise<string> {
	const dir = join(tmpdir(), `agent-watcher-test-${randomUUID()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

// Silent logger for tests
function createSilentLogger(): Logger {
	return {
		log: () => {},
		error: () => {},
		success: () => {},
	};
}

// Check if Docker is available
function isDockerAvailable(): boolean {
	try {
		execSync("docker info", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

describe("shouldIgnorePath", () => {
	it("returns true for null filename", () => {
		assert.equal(shouldIgnorePath(null), true);
	});

	it("returns true for node_modules paths", () => {
		assert.equal(shouldIgnorePath("node_modules/some-package/index.js"), true);
		assert.equal(shouldIgnorePath("src/node_modules/test.js"), true);
	});

	it("returns true for hidden files", () => {
		assert.equal(shouldIgnorePath(".gitignore"), true);
		assert.equal(shouldIgnorePath(".env"), true);
	});

	it("returns true for hidden directories", () => {
		assert.equal(shouldIgnorePath("src/.hidden/file.ts"), true);
	});

	it("returns false for normal source files", () => {
		assert.equal(shouldIgnorePath("src/index.ts"), false);
		assert.equal(shouldIgnorePath("Dockerfile"), false);
		assert.equal(shouldIgnorePath("package.json"), false);
	});
});

describe("updateEnvFile", () => {
	let tempDir: string;
	let envPath: string;

	beforeEach(async () => {
		tempDir = await createTempDir();
		envPath = join(tempDir, ".env");
	});

	after(async () => {
		// Cleanup is handled by the OS for temp directories
	});

	it("creates env file if it does not exist", async () => {
		const result = await updateEnvFile(envPath, "test-image:latest");
		assert.equal(result, true);

		const content = await readFile(envPath, "utf-8");
		assert.ok(content.includes("SANDBOX_IMAGE=test-image:latest"));
	});

	it("updates existing SANDBOX_IMAGE", async () => {
		await writeFile(
			envPath,
			"PORT=3000\nSANDBOX_IMAGE=old-image:v1\nDATABASE_URL=postgres://\n",
		);

		const result = await updateEnvFile(envPath, "new-image:v2");
		assert.equal(result, true);

		const content = await readFile(envPath, "utf-8");
		assert.ok(content.includes("SANDBOX_IMAGE=new-image:v2"));
		assert.ok(!content.includes("old-image:v1"));
		assert.ok(content.includes("PORT=3000"));
		assert.ok(content.includes("DATABASE_URL=postgres://"));
	});

	it("appends SANDBOX_IMAGE if not present", async () => {
		await writeFile(envPath, "PORT=3000\nDATABASE_URL=postgres://\n");

		const result = await updateEnvFile(envPath, "new-image:latest");
		assert.equal(result, true);

		const content = await readFile(envPath, "utf-8");
		assert.ok(content.includes("SANDBOX_IMAGE=new-image:latest"));
		assert.ok(content.includes("PORT=3000"));
	});

	it("handles empty env file", async () => {
		await writeFile(envPath, "");

		const result = await updateEnvFile(envPath, "test-image:dev");
		assert.equal(result, true);

		const content = await readFile(envPath, "utf-8");
		assert.equal(content.trim(), "SANDBOX_IMAGE=test-image:dev");
	});

	it("preserves file structure with trailing newline", async () => {
		await writeFile(envPath, "PORT=3000\n\n\n");

		const result = await updateEnvFile(envPath, "test-image:dev");
		assert.equal(result, true);

		const content = await readFile(envPath, "utf-8");
		// Should end with newline
		assert.ok(content.endsWith("\n"));
	});
});

describe("AgentWatcher", () => {
	let tempDir: string;
	let agentDir: string;
	let envPath: string;

	beforeEach(async () => {
		tempDir = await createTempDir();
		agentDir = join(tempDir, "agent");
		envPath = join(tempDir, ".env");
		await mkdir(agentDir, { recursive: true });
		// Create Dockerfile at project root (tempDir)
		await writeFile(join(tempDir, "Dockerfile"), "FROM busybox:1.36");
	});

	describe("checkAgentDirExists", () => {
		it("returns true if agent directory exists", async () => {
			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 100,
				logger: createSilentLogger(),
			});

			const exists = await watcher.checkAgentDirExists();
			assert.equal(exists, true);
		});

		it("returns false if agent directory does not exist", async () => {
			const watcher = new AgentWatcher({
				agentDir: join(tempDir, "nonexistent"),
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 100,
				logger: createSilentLogger(),
			});

			const exists = await watcher.checkAgentDirExists();
			assert.equal(exists, false);
		});
	});

	describe("with mock command runner", () => {
		it("calls docker build and inspect with correct arguments", async () => {
			const calls: Array<{ command: string; args: string[]; cwd: string }> = [];

			const mockRunner: CommandRunner = async (command, args, cwd) => {
				calls.push({ command, args, cwd });
				if (args.includes("inspect")) {
					return {
						stdout: "sha256:abc123def456\n",
						stderr: "",
						exitCode: 0,
					};
				}
				return { stdout: "", stderr: "", exitCode: 0 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "my-image",
				imageTag: "dev",
				debounceMs: 100,
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			const result = await watcher.buildImage();

			assert.equal(calls.length, 3);
			assert.equal(calls[0].command, "docker");
			assert.deepEqual(calls[0].args, ["build", "-t", "my-image:dev", "."]);
			assert.equal(calls[0].cwd, tempDir);
			assert.equal(calls[1].command, "docker");
			assert.deepEqual(calls[1].args, [
				"inspect",
				"--format={{.Id}}",
				"my-image:dev",
			]);
			assert.equal(calls[2].command, "docker");
			assert.deepEqual(calls[2].args, [
				"tag",
				"my-image:dev",
				"discobot-local/my-image:abc123de",
			]);
			assert.equal(result, "discobot-local/my-image:abc123de");
		});

		it("returns null on build failure", async () => {
			const mockRunner: CommandRunner = async () => {
				return { stdout: "", stderr: "Build failed", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "my-image",
				imageTag: "dev",
				debounceMs: 100,
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			const result = await watcher.buildImage();
			assert.equal(result, null);
		});

		it("doBuild triggers build and updates env file with tagged reference", async () => {
			let buildCalls = 0;
			const mockImageId = "sha256:abc123def456789";
			const expectedTag = "discobot-local/test-image:abc123de";

			const mockRunner: CommandRunner = async (_command, args) => {
				if (args.includes("build")) {
					buildCalls++;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("inspect")) {
					return { stdout: `${mockImageId}\n`, stderr: "", exitCode: 0 };
				}
				if (args.includes("tag")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test-image",
				imageTag: "v1",
				debounceMs: 100,
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			let buildCompleted = false;
			let completedImageRef: string | null = null;

			watcher.onBuildComplete = (success, imageRef) => {
				buildCompleted = success;
				completedImageRef = imageRef;
			};

			await watcher.doBuild();

			assert.equal(buildCalls, 1);
			assert.equal(buildCompleted, true);
			assert.equal(completedImageRef, expectedTag);

			// Check env file was updated with the tagged reference
			const envContent = await readFile(envPath, "utf-8");
			assert.ok(envContent.includes(`SANDBOX_IMAGE=${expectedTag}`));
		});

		it("queues build if one is in progress", async () => {
			let buildCount = 0;
			let resolveFirstBuild: (() => void) | undefined;
			const firstBuildPromise = new Promise<void>((resolve) => {
				resolveFirstBuild = resolve;
			});

			const mockRunner: CommandRunner = async (_command, args) => {
				if (args.includes("build")) {
					buildCount++;
					if (buildCount === 1) {
						// First build waits
						await firstBuildPromise;
					}
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("inspect")) {
					return { stdout: "sha256:test123\n", stderr: "", exitCode: 0 };
				}
				if (args.includes("tag")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 10,
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			// Start first build (will wait)
			const firstBuild = watcher.doBuild();

			// Try to trigger another build while first is in progress
			watcher.doBuild();
			watcher.doBuild();

			// Release first build
			resolveFirstBuild?.();
			await firstBuild;

			// Wait for pending build to complete
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have built twice: initial + one pending (multiple requests coalesced)
			assert.equal(buildCount, 2);
		});

		it("scheduleBuild sets pendingBuild when build is in progress", async () => {
			// This tests the race condition where:
			// 1. Build starts
			// 2. File change triggers scheduleBuild() (sets debounce timer)
			// 3. Build finishes BEFORE debounce timer fires
			// 4. Without the fix, pendingBuild would be false and rebuild would be missed
			let buildCount = 0;
			let resolveFirstBuild: (() => void) | undefined;
			const firstBuildPromise = new Promise<void>((resolve) => {
				resolveFirstBuild = resolve;
			});

			const mockRunner: CommandRunner = async (_command, args) => {
				if (args.includes("build")) {
					buildCount++;
					if (buildCount === 1) {
						// First build waits for us to release it
						await firstBuildPromise;
					}
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("inspect")) {
					return {
						stdout: `sha256:build${buildCount}\n`,
						stderr: "",
						exitCode: 0,
					};
				}
				if (args.includes("tag")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 500, // Long debounce - timer won't fire during test
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			// Start first build (will wait)
			const firstBuild = watcher.doBuild();

			// Simulate file change during build - this calls scheduleBuild(),
			// NOT doBuild() directly. The debounce timer is set but won't fire
			// for 500ms. The fix ensures pendingBuild is set immediately.
			watcher.scheduleBuild();

			// Release first build - it should see pendingBuild=true and rebuild
			resolveFirstBuild?.();
			await firstBuild;

			// Wait for the pending build to complete (triggered by finally block)
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have built twice: initial + pending triggered by scheduleBuild
			assert.equal(
				buildCount,
				2,
				"Should rebuild after scheduleBuild during build",
			);
		});
	});

	describe("file watching", () => {
		it("detects file changes and triggers build", async () => {
			const changes: Array<{ filename: string; eventType: string }> = [];

			const mockRunner: CommandRunner = async (_command, args) => {
				if (args.includes("build")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("inspect")) {
					return { stdout: "sha256:test123\n", stderr: "", exitCode: 0 };
				}
				if (args.includes("tag")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 50, // Short debounce for testing
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			watcher.onFileChange = (filename, eventType) => {
				changes.push({ filename, eventType });
			};

			// Create initial file so directory is valid
			await writeFile(join(agentDir, "package.json"), "{}");

			// Start watcher (skip initial build by mocking)
			await watcher.doBuild(); // Initial build

			// Start watching
			const watchPromise = (async () => {
				await mkdir(agentDir, { recursive: true });
				const { watch } = await import("node:fs");
				return new Promise<void>((resolve) => {
					const fsWatcher = watch(
						agentDir,
						{ recursive: true },
						(eventType, filename) => {
							if (filename && !shouldIgnorePath(filename)) {
								watcher.scheduleBuild();
								watcher.onFileChange?.(filename, eventType);
							}
						},
					);

					// Make a change after watcher is set up
					setTimeout(async () => {
						await writeFile(join(agentDir, "test.ts"), "console.log('test')");
					}, 100);

					// Wait for debounce and build
					setTimeout(() => {
						fsWatcher.close();
						resolve();
					}, 300);
				});
			})();

			await watchPromise;

			// Should have detected the change
			assert.ok(changes.length > 0, "Should have detected file changes");
			assert.ok(
				changes.some((c) => c.filename === "test.ts"),
				"Should have detected test.ts",
			);
		});

		it("detects Dockerfile changes and triggers build", async () => {
			const changes: Array<{ filename: string; eventType: string }> = [];
			let buildCount = 0;

			const mockRunner: CommandRunner = async (_command, args) => {
				if (args.includes("build")) {
					buildCount++;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				if (args.includes("inspect")) {
					return { stdout: "sha256:test123\n", stderr: "", exitCode: 0 };
				}
				if (args.includes("tag")) {
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "", exitCode: 1 };
			};

			const watcher = new AgentWatcher({
				agentDir,
				projectRoot: tempDir,
				envFilePath: envPath,
				imageName: "test",
				imageTag: "latest",
				debounceMs: 50,
				runCommand: mockRunner,
				logger: createSilentLogger(),
			});

			watcher.onFileChange = (filename, eventType) => {
				changes.push({ filename, eventType });
			};

			// Start the watcher (includes initial build and sets up file watchers)
			await watcher.start();

			const initialBuildCount = buildCount;

			// Modify the Dockerfile
			await writeFile(
				join(tempDir, "Dockerfile"),
				"FROM busybox:1.36\nRUN echo 'modified'",
			);

			// Wait for debounce and build to complete
			await new Promise((resolve) => setTimeout(resolve, 200));

			watcher.stop();

			// Should have detected the Dockerfile change
			assert.ok(
				changes.some((c) => c.filename === "Dockerfile"),
				"Should have detected Dockerfile change",
			);

			// Should have triggered a rebuild
			assert.ok(
				buildCount > initialBuildCount,
				`Should have triggered rebuild after Dockerfile change (builds: ${buildCount}, initial: ${initialBuildCount})`,
			);
		});
	});
});

describe("AgentWatcher E2E with Docker", { skip: !isDockerAvailable() }, () => {
	let tempDir: string;
	let agentDir: string;
	let envPath: string;

	before(async () => {
		tempDir = await createTempDir();
		agentDir = join(tempDir, "agent");
		envPath = join(tempDir, ".env");
		await mkdir(agentDir, { recursive: true });

		// Create a minimal Dockerfile at project root (tempDir)
		await writeFile(
			join(tempDir, "Dockerfile"),
			`FROM busybox:1.36
CMD ["echo", "hello"]
`,
		);
	});

	after(async () => {
		// Clean up test image
		try {
			execSync("docker rmi agent-watcher-test:e2e 2>/dev/null || true", {
				stdio: "ignore",
			});
		} catch {
			// Ignore cleanup errors
		}

		// Clean up temp directory
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("builds real Docker image and updates env file with short ID tag", async () => {
		const watcher = new AgentWatcher({
			agentDir,
			projectRoot: tempDir,
			envFilePath: envPath,
			imageName: "agent-watcher-test",
			imageTag: "e2e",
			debounceMs: 100,
			logger: createSilentLogger(),
		});

		let buildSuccess = false;
		let imageRef: string | null = null;

		watcher.onBuildComplete = (success, ref) => {
			buildSuccess = success;
			imageRef = ref;
		};

		await watcher.doBuild();

		assert.equal(buildSuccess, true, "Build should succeed");
		assert.ok(imageRef, "Image reference should not be null");
		assert.ok(
			(imageRef as string).startsWith("discobot-local/"),
			`Should return tagged reference (discobot-local/...), got: ${imageRef}`,
		);

		// Extract the short ID from the returned reference
		const shortId = (imageRef as string).split(":")[1];
		assert.equal(shortId?.length, 8, "Short ID should be 8 characters");

		// Verify env file was updated with the tagged reference
		const envContent = await readFile(envPath, "utf-8");
		assert.ok(
			envContent.includes("SANDBOX_IMAGE=discobot-local/"),
			"Env file should contain tagged reference",
		);

		// Verify the reference in env file matches what was returned
		assert.ok(
			envContent.includes(`SANDBOX_IMAGE=${imageRef}`),
			"Env file should contain the exact tagged reference",
		);

		// Verify the short ID matches the first 8 chars of the actual image ID
		const inspectResult = execSync(
			"docker inspect agent-watcher-test:e2e --format '{{.Id}}'",
			{ encoding: "utf-8" },
		);
		const actualImageId = inspectResult.trim().replace(/^sha256:/, "");
		assert.equal(
			actualImageId.slice(0, 8),
			shortId,
			"Short ID should match first 8 chars of actual image ID",
		);
	});
});
