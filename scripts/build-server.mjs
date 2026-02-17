import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(__dirname);
const serverDir = join(projectRoot, "server");
const binariesDir = join(projectRoot, "src-tauri", "binaries");

// Get version from environment (CI) or default to "main" for dev builds
// In CI, DISCOBOT_VERSION is set from the git tag (e.g., "0.1.0-12")
const version = process.env.DISCOBOT_VERSION || "main";

// Create binaries directory
mkdirSync(binariesDir, { recursive: true });

// Get target triple from environment or detect from current platform
function getTargetTriple() {
	// Use TAURI_TARGET_TRIPLE if set (from CI workflow)
	if (process.env.TAURI_TARGET_TRIPLE) {
		return process.env.TAURI_TARGET_TRIPLE;
	}

	const platform = os.platform();
	const arch = os.arch();

	if (platform === "linux") {
		if (arch === "x64") return "x86_64-unknown-linux-gnu";
		if (arch === "arm64") return "aarch64-unknown-linux-gnu";
	} else if (platform === "darwin") {
		if (arch === "x64") return "x86_64-apple-darwin";
		if (arch === "arm64") return "aarch64-apple-darwin";
	} else if (platform === "win32") {
		if (arch === "x64") return "x86_64-pc-windows-msvc";
		if (arch === "arm64") return "aarch64-pc-windows-msvc";
	}

	throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

const targetTriple = getTargetTriple();
const ext = targetTriple.includes("windows") ? ".exe" : "";
const outputName = `discobot-server-${targetTriple}${ext}`;
const outputPath = join(binariesDir, outputName);

// Map target triple to Go cross-compilation env vars
function getGoEnv(triple) {
	const archMap = {
		x86_64: "amd64",
		aarch64: "arm64",
	};
	const osMap = {
		"apple-darwin": "darwin",
		"unknown-linux-gnu": "linux",
		"pc-windows-msvc": "windows",
	};

	const [cpu, ...rest] = triple.split("-");
	const osKey = rest.join("-");

	return {
		GOARCH: archMap[cpu],
		GOOS: osMap[osKey],
	};
}

const goEnv = getGoEnv(targetTriple);
console.log(
	`Building discobot-server ${version} for ${targetTriple} (GOOS=${goEnv.GOOS}, GOARCH=${goEnv.GOARCH})...`,
);

// Build with version injected via ldflags
const ldflags = `-X github.com/obot-platform/discobot/server/internal/version.Version=${version}`;
execSync(`go build -ldflags "${ldflags}" -o "${outputPath}" ./cmd/server`, {
	cwd: serverDir,
	stdio: "inherit",
	env: { ...process.env, ...goEnv },
});

console.log(`Built: ${outputPath} (version: ${version})`);
