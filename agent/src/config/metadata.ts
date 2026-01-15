import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Default path where VirtioFS metadata is mounted in the VM.
 * The host shares a metadata directory via VirtioFS with tag "octobot-meta".
 * The guest mounts it at this path.
 */
export const METADATA_PATH =
	process.env.METADATA_PATH || "/run/octobot/metadata";

/**
 * VsockConfig configures vsock-to-TCP forwarding.
 */
export interface VsockConfig {
	/** vsock port to listen on (host connects to this) */
	port: number;
	/** TCP port to forward to (where HTTP server listens) */
	target_port?: number;
}

/**
 * VMMetadata contains configuration passed from the host via VirtioFS.
 */
export interface VMMetadata {
	session_id: string;
	secret?: string;
	env?: Record<string, string>;
	workspace?: {
		path?: string;
		commit?: string;
		mount_point?: string;
	};
	agent?: {
		command?: string;
		args?: string[];
		workdir?: string;
		port?: number;
		/** If set, agent should start socat to forward vsock to TCP */
		vsock?: VsockConfig;
	};
}

/**
 * Reads the metadata.json file from the VirtioFS mount.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readMetadata(): VMMetadata | null {
	const metadataFile = join(METADATA_PATH, "metadata.json");

	if (!existsSync(metadataFile)) {
		return null;
	}

	try {
		const content = readFileSync(metadataFile, "utf-8");
		return JSON.parse(content) as VMMetadata;
	} catch (error) {
		console.error(`Failed to read metadata from ${metadataFile}:`, error);
		return null;
	}
}

/**
 * Reads a single metadata file by name.
 * Returns null if the file doesn't exist.
 */
export function readMetadataFile(name: string): string | null {
	const filePath = join(METADATA_PATH, name);

	if (!existsSync(filePath)) {
		return null;
	}

	try {
		return readFileSync(filePath, "utf-8").trim();
	} catch (error) {
		console.error(`Failed to read metadata file ${filePath}:`, error);
		return null;
	}
}

/**
 * Checks if running in a VM with VirtioFS metadata available.
 */
export function hasMetadata(): boolean {
	return existsSync(join(METADATA_PATH, "metadata.json"));
}

/**
 * AgentConfig represents the resolved configuration for the agent.
 * This is built from VirtioFS metadata with environment variable fallbacks.
 */
export interface AgentConfig {
	agentCommand: string;
	agentArgs: string[];
	agentCwd: string;
	port: number;
	sharedSecretHash?: string;
	sessionId?: string;
	workspacePath?: string;
	workspaceCommit?: string;
	/** If set, start socat to forward vsock to TCP */
	vsock?: VsockConfig;
}

/**
 * Loads agent configuration from VirtioFS metadata with environment variable fallbacks.
 *
 * Priority:
 * 1. VirtioFS metadata (if available)
 * 2. Environment variables
 * 3. Default values
 */
export function loadConfig(): AgentConfig {
	const metadata = readMetadata();

	// Agent command
	const agentCommand =
		metadata?.agent?.command || process.env.AGENT_COMMAND || "claude-code-acp";

	// Agent arguments
	const agentArgs =
		metadata?.agent?.args ||
		process.env.AGENT_ARGS?.split(" ").filter(Boolean) ||
		[];

	// Working directory
	const agentCwd =
		metadata?.agent?.workdir ||
		metadata?.workspace?.mount_point ||
		process.env.AGENT_CWD ||
		process.cwd();

	// Port
	const port = metadata?.agent?.port || Number(process.env.PORT) || 3002;

	// Shared secret - from metadata or environment
	const sharedSecretHash = metadata?.secret || process.env.OCTOBOT_SECRET;

	// Clear from environment so subprocess doesn't see it
	if (process.env.OCTOBOT_SECRET) {
		delete process.env.OCTOBOT_SECRET;
	}

	// Session ID
	const sessionId =
		metadata?.session_id ||
		readMetadataFile("session_id") ||
		process.env.SESSION_ID;

	// Workspace
	const workspacePath = metadata?.workspace?.path || process.env.WORKSPACE_PATH;

	const workspaceCommit =
		metadata?.workspace?.commit || process.env.WORKSPACE_COMMIT;

	// Vsock config (only from metadata, no env fallback)
	const vsock = metadata?.agent?.vsock;

	return {
		agentCommand,
		agentArgs,
		agentCwd,
		port,
		sharedSecretHash,
		sessionId,
		workspacePath,
		workspaceCommit,
		vsock,
	};
}
