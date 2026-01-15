#!/usr/bin/env node
import { execSync } from "child_process";
import { createInterface } from "readline";

const rl = createInterface({
	input: process.stdin,
	output: process.stdout,
});

function prompt(question) {
	return new Promise((resolve) => {
		rl.question(question, resolve);
	});
}

function exec(cmd, options = {}) {
	return execSync(cmd, { encoding: "utf-8", ...options }).trim();
}

function getLatestTag() {
	try {
		const tags = exec("git tag --sort=-v:refname").split("\n").filter(Boolean);
		// Find the latest v* tag
		return tags.find((t) => t.startsWith("v")) || null;
	} catch {
		return null;
	}
}

function parseVersion(tag) {
	// Parse versions like v0.0.1-alpha9, v0.0.1, v1.2.3-beta.1
	const match = tag?.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)(\d+)?)?$/);
	if (!match) return null;

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
		prerelease: match[4] || null,
		prereleaseNum: match[5] ? parseInt(match[5], 10) : null,
	};
}

function formatVersion(v) {
	let version = `${v.major}.${v.minor}.${v.patch}`;
	if (v.prerelease) {
		version += `-${v.prerelease}${v.prereleaseNum ?? ""}`;
	}
	return version;
}

function suggestNextVersion(current) {
	if (!current) {
		return "0.0.1-alpha1";
	}

	const v = { ...current };

	if (v.prerelease && v.prereleaseNum !== null) {
		// Increment prerelease number: alpha9 -> alpha10
		v.prereleaseNum++;
	} else if (v.prerelease) {
		// Add number to prerelease: alpha -> alpha1
		v.prereleaseNum = 1;
	} else {
		// Increment patch: 0.0.1 -> 0.0.2
		v.patch++;
	}

	return formatVersion(v);
}

async function main() {
	console.log("Release Script\n");

	// Check for uncommitted changes
	const status = exec("git status --porcelain");
	if (status) {
		console.log("Warning: You have uncommitted changes:\n");
		console.log(status);
		const proceed = await prompt("\nContinue anyway? (y/N): ");
		if (proceed.toLowerCase() !== "y") {
			console.log("Aborted.");
			process.exit(1);
		}
	}

	// Get current version info
	const latestTag = getLatestTag();
	const currentVersion = parseVersion(latestTag);
	const suggestedVersion = suggestNextVersion(currentVersion);

	console.log(`Latest tag: ${latestTag || "(none)"}`);
	console.log(`Suggested next version: ${suggestedVersion}\n`);

	// Prompt for version
	const input = await prompt(`Enter version (default: ${suggestedVersion}): `);
	const newVersion = input.trim() || suggestedVersion;

	// Validate version format
	if (!parseVersion(`v${newVersion}`)) {
		console.error(
			`Invalid version format: ${newVersion}. Expected format like 0.0.1 or 0.0.1-alpha1`,
		);
		process.exit(1);
	}

	const newTag = `v${newVersion}`;
	console.log(`\nWill create version: ${newVersion} (tag: ${newTag})`);

	const confirm = await prompt("Proceed? (Y/n): ");
	if (confirm.toLowerCase() === "n") {
		console.log("Aborted.");
		process.exit(1);
	}

	rl.close();

	// Run npm version (updates package.json, commits, and tags)
	console.log("\nUpdating version...");
	try {
		exec(`npm version ${newVersion} -m "chore(release): v%s"`, {
			stdio: "inherit",
		});
	} catch (e) {
		console.error("Failed to update version:", e.message);
		process.exit(1);
	}

	// Push to GitHub
	console.log("\nPushing to GitHub...");
	try {
		exec("git push origin main --tags", { stdio: "inherit" });
	} catch (e) {
		console.error("Failed to push:", e.message);
		process.exit(1);
	}

	console.log(`\nReleased ${newTag}!`);
	console.log(
		`Watch the build at: https://github.com/ibuildthecloud/octobot/actions`,
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
