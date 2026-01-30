#!/usr/bin/env npx tsx
/**
 * Agent Image Watcher - Entry point
 *
 * Watches the ./agent-api, ./agent directories and ./Dockerfile for changes
 * and automatically rebuilds the Docker image, then updates server/.env with
 * the new image digest.
 *
 * Usage: npx tsx scripts/agent-watcher/index.ts
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentWatcher } from "./watcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const AGENT_API_DIR = join(ROOT_DIR, "agent-api");
const AGENT_DIR = join(ROOT_DIR, "agent");
const SERVER_ENV_PATH = join(ROOT_DIR, "server", ".env");

const watcher = new AgentWatcher({
	agentDir: AGENT_API_DIR,
	additionalDirs: [AGENT_DIR],
	projectRoot: ROOT_DIR,
	envFilePath: SERVER_ENV_PATH,
	imageName: "octobot-agent-api",
	imageTag: "dev",
	debounceMs: 500,
});

watcher.start().catch((err) => {
	console.error(`Fatal error: ${err}`);
	process.exit(1);
});
