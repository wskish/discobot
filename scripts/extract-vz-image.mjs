#!/usr/bin/env node
/**
 * Extract VZ image files from Docker registry for Tauri bundling
 *
 * This script uses `crane` (from go-containerregistry) to pull a VZ Docker
 * image from the registry and extract the kernel and rootfs files to
 * src-tauri/resources/ for bundling into the macOS app.
 *
 * Prerequisites: crane must be installed (go install github.com/google/go-containerregistry/cmd/crane@latest)
 *
 * Usage: node scripts/extract-vz-image.mjs <image-ref> [arch]
 *   image-ref: Docker image reference (e.g., ghcr.io/obot-platform/discobot-vz:0.1.0)
 *   arch: Architecture (amd64 or arm64, defaults to host arch)
 */

import { execSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const resourcesDir = join(projectRoot, "src-tauri", "resources");

// Parse arguments
const imageRef = process.argv[2];
const arch =
	process.argv[3] || (process.arch === "arm64" ? "arm64" : "amd64");

if (!imageRef) {
	console.error("Error: Image reference is required");
	console.error("Usage: node scripts/extract-vz-image.mjs <image-ref> [arch]");
	console.error(
		"Example: node scripts/extract-vz-image.mjs ghcr.io/obot-platform/discobot-vz:0.1.0 arm64",
	);
	process.exit(1);
}

// Ensure resources directory exists
mkdirSync(resourcesDir, { recursive: true });

console.log(`Extracting VZ image files for ${arch}...`);
console.log(`Image: ${imageRef}`);
console.log(`Output directory: ${resourcesDir}`);

const files = ["vmlinuz", "kernel-version", "discobot-rootfs.squashfs"];

try {
	// Use crane to export the image filesystem as a tar and extract the files
	// crane doesn't require a Docker daemon, making it suitable for macOS CI
	console.log(`Exporting image with crane (platform linux/${arch})...`);
	execSync(
		`crane export --platform "linux/${arch}" "${imageRef}" - | tar xf - -C "${resourcesDir}" ${files.join(" ")}`,
		{ stdio: "inherit" },
	);

	console.log("VZ image files extracted successfully:");
	for (const file of files) {
		const filePath = join(resourcesDir, file);
		try {
			const stats = statSync(filePath);
			const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
			console.log(`  ${file}: ${sizeMB} MB`);
		} catch {
			console.log(`  ${file} (size unknown)`);
		}
	}
} catch (error) {
	console.error("Failed to extract VZ image:", error.message);
	process.exit(1);
}
