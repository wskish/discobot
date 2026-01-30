#!/usr/bin/env node
/**
 * Build VZ disk image for macOS Virtualization.framework
 *
 * This script only builds the VZ image on macOS (darwin) since it's only
 * useful there. On other platforms, it creates the resources directory
 * but skips the Docker build.
 *
 * Usage: node scripts/build-vz-image.mjs [--force]
 *   --force: Build even on non-macOS platforms (for CI cross-compilation)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const resourcesDir = join(projectRoot, "src-tauri", "resources");

const isDarwin = process.platform === "darwin";
const forceFlag = process.argv.includes("--force");

// Ensure resources directory exists
mkdirSync(resourcesDir, { recursive: true });

if (!isDarwin && !forceFlag) {
	console.log("Skipping VZ image build (not on macOS)");
	console.log("Use --force to build anyway");
	process.exit(0);
}

// Check if Docker is available
try {
	execSync("docker --version", { stdio: "ignore" });
} catch {
	console.error("Error: Docker is not available");
	console.error("Docker is required to build the VZ disk image");
	process.exit(1);
}

console.log("Building VZ disk image...");
console.log(`Output directory: ${resourcesDir}`);

try {
	execSync(
		`docker build --target vz-disk-image --output type=local,dest="${resourcesDir}" .`,
		{
			cwd: projectRoot,
			stdio: "inherit",
		},
	);
	console.log("VZ disk image built successfully");

	// Verify output
	const outputFile = join(resourcesDir, "discobot-rootfs.img.zst");
	if (existsSync(outputFile)) {
		console.log(`Output: ${outputFile}`);
	} else {
		console.error("Warning: Expected output file not found");
	}
} catch (error) {
	console.error("Failed to build VZ disk image:", error.message);
	process.exit(1);
}
