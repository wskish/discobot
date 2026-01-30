/**
 * Service Front Matter Parser
 *
 * Parses YAML front matter from service executable files.
 * Supports three delimiter styles:
 * - Plain: ---
 * - Hash comment: #---
 * - Slash comment: //---
 *
 * Whitespace after comment prefix is allowed, but must be consistent
 * (subsequent lines must have <= whitespace than the first content line).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Service, ServiceConfig } from "../api/types.js";

/**
 * Result of parsing front matter from a service file
 */
export interface ParseResult {
	/** Parsed configuration */
	config: ServiceConfig;
	/** Line number where the script body starts (0-indexed) */
	bodyStart: number;
	/** Whether the file has a shebang line */
	hasShebang: boolean;
	/** Whether the body (content after front matter) is empty/whitespace only */
	hasEmptyBody: boolean;
}

/**
 * Delimiter types for front matter
 */
type DelimiterStyle = "plain" | "hash" | "slash";

interface DetectedDelimiter {
	style: DelimiterStyle;
	prefix: string; // '' for plain, '#' for hash, '//' for slash
	delimiter: string; // '---', '#---', or '//---'
}

/**
 * Detect the delimiter style from a line
 */
function detectDelimiter(line: string): DetectedDelimiter | null {
	const trimmed = line.trim();

	if (trimmed === "---") {
		return { style: "plain", prefix: "", delimiter: "---" };
	}
	if (trimmed === "#---") {
		return { style: "hash", prefix: "#", delimiter: "#---" };
	}
	if (trimmed === "//---") {
		return { style: "slash", prefix: "//", delimiter: "//---" };
	}

	return null;
}

/**
 * Strip prefix and any following whitespace from a content line
 */
function stripPrefixAndWhitespace(line: string, prefix: string): string {
	if (!prefix) {
		// Plain style - just return the line (preserve internal structure)
		return line;
	}

	// Comment style - find and remove prefix + all following whitespace
	const prefixIndex = line.indexOf(prefix);
	if (prefixIndex === -1) {
		return line; // No prefix found, return as-is
	}

	const afterPrefix = line.slice(prefixIndex + prefix.length);

	// Trim all leading whitespace after the prefix
	return afterPrefix.trimStart();
}

/**
 * Parse simple YAML key-value pairs
 * Only supports flat structure with string and number values
 */
function parseSimpleYaml(content: string): ServiceConfig {
	const config: ServiceConfig = {};

	for (const line of content.split("\n")) {
		const trimmed = line.trim();

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const colonIndex = trimmed.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, colonIndex).trim();
		let value = trimmed.slice(colonIndex + 1).trim();

		// Remove quotes if present
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		switch (key) {
			case "name":
				config.name = value;
				break;
			case "description":
				config.description = value;
				break;
			case "http": {
				const port = Number.parseInt(value, 10);
				if (!Number.isNaN(port) && port > 0 && port < 65536) {
					config.http = port;
				}
				break;
			}
			case "https": {
				const port = Number.parseInt(value, 10);
				if (!Number.isNaN(port) && port > 0 && port < 65536) {
					config.https = port;
				}
				break;
			}
			case "path":
				// URL path for web preview - ensure it starts with /
				config.urlPath = value.startsWith("/") ? value : `/${value}`;
				break;
		}
	}

	return config;
}

/**
 * Check if the body content (after front matter) is empty or whitespace only.
 */
function isBodyEmpty(lines: string[], bodyStart: number): boolean {
	for (let i = bodyStart; i < lines.length; i++) {
		if (lines[i].trim() !== "") {
			return false;
		}
	}
	return true;
}

/**
 * Parse front matter from a service file content.
 *
 * Supports two formats:
 * 1. Executable scripts: Start with shebang (#!), front matter on line 1
 * 2. Passive services: Start directly with front matter delimiter (no shebang)
 *
 * @param content - The full content of the service file
 * @returns ParseResult with config, body info, and flags
 */
export function parseFrontMatter(content: string): ParseResult {
	const lines = content.split("\n");

	if (lines.length === 0) {
		return {
			config: {},
			bodyStart: 0,
			hasShebang: false,
			hasEmptyBody: true,
		};
	}

	// Check if first line is a shebang
	const hasShebang = lines[0]?.startsWith("#!") ?? false;

	// Determine which line to check for front matter delimiter
	const frontMatterStartLine = hasShebang ? 1 : 0;

	// Check if we have enough lines for front matter
	if (lines.length <= frontMatterStartLine) {
		return {
			config: {},
			bodyStart: lines.length,
			hasShebang,
			hasEmptyBody: true,
		};
	}

	const delimiter = detectDelimiter(lines[frontMatterStartLine]);
	if (!delimiter) {
		// No front matter found
		const bodyStart = hasShebang ? 1 : 0;
		return {
			config: {},
			bodyStart,
			hasShebang,
			hasEmptyBody: isBodyEmpty(lines, bodyStart),
		};
	}

	// Extract lines until closing delimiter
	const yamlLines: string[] = [];
	let closingLineIndex = -1;

	for (let i = frontMatterStartLine + 1; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// Check for closing delimiter
		if (trimmed === delimiter.delimiter) {
			closingLineIndex = i;
			break;
		}

		// For comment-prefixed styles, line must contain the prefix
		if (delimiter.prefix && !line.includes(delimiter.prefix)) {
			// Allow empty lines
			if (trimmed === "") {
				yamlLines.push("");
				continue;
			}
			// Line doesn't have expected prefix - invalid front matter
			const bodyStart = hasShebang ? 1 : 0;
			return {
				config: {},
				bodyStart,
				hasShebang,
				hasEmptyBody: isBodyEmpty(lines, bodyStart),
			};
		}

		// Strip prefix and all following whitespace, add to yaml content
		const yamlLine = stripPrefixAndWhitespace(line, delimiter.prefix);
		yamlLines.push(yamlLine);
	}

	// If no closing delimiter found, treat as no front matter
	if (closingLineIndex === -1) {
		const bodyStart = hasShebang ? 1 : 0;
		return {
			config: {},
			bodyStart,
			hasShebang,
			hasEmptyBody: isBodyEmpty(lines, bodyStart),
		};
	}

	// Parse the YAML content
	const yamlContent = yamlLines.join("\n");
	const config = parseSimpleYaml(yamlContent);
	const bodyStart = closingLineIndex + 1;

	return {
		config,
		bodyStart,
		hasShebang,
		hasEmptyBody: isBodyEmpty(lines, bodyStart),
	};
}

/**
 * Normalize a filename to a valid service ID.
 *
 * Service IDs can only contain: a-z0-9_- (lowercase)
 *
 * Transformation:
 * 1. Remove common extensions (.sh, .py, .js, .ts, .rb, .pl, .bash, .zsh)
 * 2. Replace remaining dots with hyphens
 * 3. Convert to lowercase
 * 4. Remove any other invalid characters
 *
 * Examples:
 *   "dev.sh" -> "dev"
 *   "foo.bar.sh" -> "foo-bar"
 *   "My_Service.py" -> "my_service"
 *   "Test.Config.js" -> "test-config"
 *
 * @param filename - The original filename
 * @returns Normalized service ID (lowercase)
 */
export function normalizeServiceId(filename: string): string {
	// Common script extensions to strip
	const extensions = [
		".sh",
		".bash",
		".zsh",
		".py",
		".js",
		".ts",
		".rb",
		".pl",
		".php",
	];

	let id = filename;

	// Remove extension if present (case-insensitive check)
	const lowerFilename = filename.toLowerCase();
	for (const ext of extensions) {
		if (lowerFilename.endsWith(ext)) {
			id = id.slice(0, -ext.length);
			break;
		}
	}

	// Replace dots with hyphens
	id = id.replace(/\./g, "-");

	// Convert to lowercase
	id = id.toLowerCase();

	// Remove any characters that aren't a-z0-9_-
	id = id.replace(/[^a-z0-9_-]/g, "");

	// Remove leading/trailing hyphens
	id = id.replace(/^-+|-+$/g, "");

	return id;
}

/**
 * Discover all services in the services directory.
 *
 * Services can be:
 * 1. Executable scripts: Must be executable, have a shebang, and have a body
 * 2. Passive services: Declare an HTTP/HTTPS port but have no body to execute.
 *    These don't need to be executable and don't need a shebang.
 *
 * A passive service is detected when:
 * - The file has front matter with http or https port defined
 * - The body after front matter is empty (whitespace only)
 *
 * @param servicesDir - Path to .discobot/services directory
 * @returns Array of Service objects (with status: "stopped")
 */
export async function discoverServices(
	servicesDir: string,
): Promise<Service[]> {
	const services: Service[] = [];

	try {
		const entries = await readdir(servicesDir, { withFileTypes: true });

		for (const entry of entries) {
			// Skip directories and hidden files
			if (entry.isDirectory() || entry.name.startsWith(".")) {
				continue;
			}

			const filePath = join(servicesDir, entry.name);

			try {
				// Check if file is executable
				const fileStat = await stat(filePath);
				const isExecutable = (fileStat.mode & 0o111) !== 0;

				// Read and parse the file
				const content = await readFile(filePath, "utf-8");
				const result = parseFrontMatter(content);

				// Determine if this is a passive service:
				// - Has http or https port defined
				// - Body is empty (no script to execute)
				const hasPort = !!(result.config.http || result.config.https);
				const isPassive = hasPort && result.hasEmptyBody;

				// For non-passive services, require executable and shebang
				if (!isPassive) {
					if (!isExecutable || !result.hasShebang) {
						continue;
					}
				}

				const serviceId = normalizeServiceId(entry.name);
				const service: Service = {
					id: serviceId,
					name: result.config.name || serviceId,
					description: result.config.description,
					http: result.config.http,
					https: result.config.https,
					path: filePath,
					urlPath: result.config.urlPath,
					status: "stopped",
					passive: isPassive || undefined,
				};

				services.push(service);
			} catch {}
		}
	} catch {
		// Directory doesn't exist or can't be read - return empty list
		return [];
	}

	// Sort by name for consistent ordering
	services.sort((a, b) => a.name.localeCompare(b.name));

	return services;
}
