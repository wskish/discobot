#!/usr/bin/env npx tsx
/**
 * VZ Image Watcher - Entry point
 *
 * Watches the Dockerfile and ./vm-assets directory for changes and automatically
 * rebuilds the VZ image (kernel + squashfs rootfs), extracts the output files,
 * decompresses the kernel, and updates server/.env with the paths.
 *
 * Usage: npx tsx scripts/vz-watcher/index.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VzWatcher } from "./watcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const SERVER_ENV_PATH = join(ROOT_DIR, "server", ".env");
const OUTPUT_DIR = join(ROOT_DIR, "build", "vz");

const watcher = new VzWatcher({
	projectRoot: ROOT_DIR,
	watchDirs: [join(ROOT_DIR, "vm-assets")],
	envFilePath: SERVER_ENV_PATH,
	outputDir: OUTPUT_DIR,
	debounceMs: 500,
});

watcher.start().catch((err) => {
	console.error(`Fatal error: ${err}`);
	process.exit(1);
});
