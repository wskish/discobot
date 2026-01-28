// API Types - shared between client and server

import type {
	CommitStatus as CommitStatusConstants,
	SessionStatus as SessionStatusConstants,
	WorkspaceStatus as WorkspaceStatusConstants,
} from "./api-constants";

/** User preference key-value pair */
export interface UserPreference {
	key: string;
	value: string;
	updatedAt?: string;
}

/** File status in diff */
export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileNode {
	id: string;
	name: string;
	type: "file" | "folder";
	children?: FileNode[];
	content?: string;
	originalContent?: string;
	changed?: boolean;
	/** File status: added, modified, deleted, or renamed */
	status?: FileStatus;
}

// Session status values representing the lifecycle of a session
export type SessionStatus =
	(typeof SessionStatusConstants)[keyof typeof SessionStatusConstants];

// Commit status values representing the commit state of a session (orthogonal to session status)
export type CommitStatus =
	(typeof CommitStatusConstants)[keyof typeof CommitStatusConstants];

export interface Session {
	id: string;
	name: string;
	/** Optional display name for the session (if not set, name is used) */
	displayName?: string;
	description: string;
	timestamp: string;
	status: SessionStatus;
	/** Commit status (orthogonal to session status) */
	commitStatus?: CommitStatus;
	/** Error message if commit status is "failed" */
	commitError?: string;
	/** Workspace commit SHA when commit started (expected parent) */
	baseCommit?: string;
	/** Final commit SHA after patches applied to workspace */
	appliedCommit?: string;
	/** Error message if status is "error" */
	errorMessage?: string;
	files: FileNode[];
	workspaceId?: string;
	agentId?: string;
}

// Workspace status values representing the lifecycle of a workspace
export type WorkspaceStatus =
	(typeof WorkspaceStatusConstants)[keyof typeof WorkspaceStatusConstants];

export interface Workspace {
	id: string;
	path: string;
	/** Optional display name for the workspace (if not set, path is used) */
	displayName?: string;
	sourceType: "local" | "git";
	status: WorkspaceStatus;
	/** Error message if status is "error" */
	errorMessage?: string;
	/** Current commit SHA (if git workspace) */
	commit?: string;
	/** Working directory path on disk (if initialized) */
	workDir?: string;
}

export interface Agent {
	id: string;
	name: string;
	description: string;
	agentType: string; // references SupportedAgentType.id
	systemPrompt?: string;
	mcpServers?: MCPServer[];
	isDefault?: boolean;
}

export interface MCPServerStdio {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

export interface MCPServerHttp {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPServerStdio | MCPServerHttp;

export interface MCPServer {
	id: string;
	name: string;
	config: MCPServerConfig;
	enabled: boolean;
}

export interface Badge {
	label: string;
	className: string;
}

export interface AuthProvider {
	id: string;
	name: string;
	description?: string;
	icons?: Icon[];
	env?: string[]; // Environment variable names for API keys
}

export interface SupportedAgentType {
	id: string;
	name: string;
	description: string;
	icons?: Icon[];
	badges?: Badge[];
	/** Whether this agent should be highlighted/featured in the UI */
	highlighted?: boolean;
	modes?: AgentMode[];
	models?: AgentModel[];
	/** Auth provider IDs this agent supports. Use ["*"] for all providers */
	supportedAuthProviders?: string[];
	/** Auth providers to highlight/feature when selecting this agent */
	highlightedAuthProviders?: string[];
	/** Whether this agent can work without authentication */
	allowNoAuth?: boolean;
}

export interface AgentMode {
	id: string;
	name: string;
	description?: string;
}

export interface AgentModel {
	id: string;
	name: string;
	provider?: string;
	description?: string;
}

// ChatMessage is re-exported from AI SDK for convenience
// The actual type is UIMessage from 'ai' package
export type { UIMessage as ChatMessage } from "ai";

export interface Suggestion {
	value: string;
	type: "path" | "repo";
}

// API Request/Response types
export interface CreateWorkspaceRequest {
	path: string;
	displayName?: string;
	sourceType: "local" | "git";
}

export interface CreateSessionRequest {
	name: string;
	agentId: string;
	/** Initial message to start the chat session with */
	initialMessage?: string;
}

export interface UpdateSessionRequest {
	name?: string;
	displayName?: string | null;
	status?: SessionStatus;
}

export interface CreateAgentRequest {
	name: string;
	description: string;
	agentType: string;
	systemPrompt?: string;
	mcpServers?: MCPServer[];
}

export interface UpdateAgentRequest {
	name?: string;
	description?: string;
	systemPrompt?: string;
	mcpServers?: MCPServer[];
}

export interface TerminalExecuteRequest {
	command: string;
	sessionId?: string;
}

export interface TerminalExecuteResponse {
	output: string;
	exitCode: number;
}

export interface TerminalMessage {
	type: "input" | "output" | "resize";
	data?: string;
	cols?: number;
	rows?: number;
}

export interface Icon {
	/**
	 * A standard URI pointing to an icon resource. May be an HTTP/HTTPS URL or a
	 * `data:` URI with Base64-encoded image data.
	 */
	src: string;
	/**
	 * Optional MIME type override if the source MIME type is missing or generic.
	 */
	mimeType?: string;
	/**
	 * Optional array of strings that specify sizes at which the icon can be used.
	 * Each string should be in WxH format (e.g., "48x48", "96x96") or "any" for scalable formats like SVG.
	 */
	sizes?: string[];
	/**
	 * Optional specifier for the theme this icon is designed for.
	 */
	theme?: "light" | "dark";
	/**
	 * If true, invert colors for dark mode (for black-on-white icons).
	 */
	invertDark?: boolean;
}

export interface Icons {
	/**
	 * Optional set of sized icons that the client can display in a user interface.
	 */
	icons?: Icon[];
}

export type CredentialAuthType = "api_key" | "oauth";

export interface OAuthData {
	access?: string;
	refresh?: string;
	expires?: number;
}

export interface Credential {
	id: string;
	name: string;
	provider: string;
	authType: CredentialAuthType;
	/** API key for api_key auth type (stored server-side, not returned to client) */
	apiKey?: string;
	/** OAuth tokens for oauth auth type (stored server-side, not returned to client) */
	oauthData?: OAuthData;
	/** Whether the credential is configured */
	isConfigured: boolean;
	/** When the credential was last updated */
	updatedAt?: string;
}

/** Client-safe credential (no secrets) */
export interface CredentialInfo {
	id: string;
	name: string;
	provider: string;
	authType: CredentialAuthType;
	isConfigured: boolean;
	updatedAt?: string;
}

export interface CreateCredentialRequest {
	provider: string;
	authType: CredentialAuthType;
	apiKey?: string;
	oauthData?: OAuthData;
}

export interface OAuthExchangeRequest {
	code: string;
	verifier: string;
}

export interface OAuthExchangeResponse {
	success: boolean;
	error?: string;
}

export interface OAuthAuthorizeResponse {
	url: string;
	verifier: string;
}

// GitHub Copilot OAuth types
export interface GitHubCopilotDeviceCodeRequest {
	deploymentType?: "github.com" | "enterprise";
	enterpriseUrl?: string;
}

export interface GitHubCopilotDeviceCodeResponse {
	verificationUri: string;
	userCode: string;
	deviceCode: string;
	interval: number;
	expiresIn: number;
	domain: string;
}

export interface GitHubCopilotPollRequest {
	deviceCode: string;
	domain: string;
}

export interface GitHubCopilotPollResponse {
	status: "pending" | "success" | "error";
	error?: string;
}

// Codex (ChatGPT) OAuth types
export interface CodexAuthorizeResponse {
	url: string;
	verifier: string;
	state: string;
}

export interface CodexExchangeRequest {
	code: string;
	verifier: string;
}

export interface CodexExchangeResponse {
	success: boolean;
	error?: string;
	accountId?: string;
}

// System Status types
export type StatusMessageLevel = "warn" | "error";

export interface StatusMessage {
	id: string;
	level: StatusMessageLevel;
	title: string;
	message: string;
}

export interface SystemStatusResponse {
	ok: boolean;
	messages: StatusMessage[];
}

// ============================================================================
// Session File System Types
// ============================================================================

/** File entry in a directory listing */
export interface SessionFileEntry {
	name: string;
	type: "file" | "directory";
	size?: number;
}

/** Response from listing session files */
export interface ListSessionFilesResponse {
	path: string;
	entries: SessionFileEntry[];
}

/** Response from reading a session file */
export interface ReadSessionFileResponse {
	path: string;
	content: string;
	encoding: "utf8" | "base64";
	size: number;
}

/** Request to write a session file */
export interface WriteSessionFileRequest {
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
	/** Original content for optimistic locking - if provided, server validates before write */
	originalContent?: string;
}

/** Response from writing a session file */
export interface WriteSessionFileResponse {
	path: string;
	size: number;
}

/** Error response when file content has changed (optimistic locking conflict) */
export interface WriteSessionFileConflictError {
	error: "conflict";
	message: string;
	/** Current content on the server */
	currentContent: string;
}

/** Single file diff entry */
export interface SessionFileDiffEntry {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	patch?: string;
}

/** Diff statistics */
export interface SessionDiffStats {
	filesChanged: number;
	additions: number;
	deletions: number;
}

/** Full diff response */
export interface SessionDiffResponse {
	files: SessionFileDiffEntry[];
	stats: SessionDiffStats;
}

/** File entry with status for diff response */
export interface SessionDiffFileEntry {
	path: string;
	status: FileStatus;
	oldPath?: string; // For renamed files
}

/** Files-only diff response (with status) */
export interface SessionDiffFilesResponse {
	files: SessionDiffFileEntry[];
	stats: SessionDiffStats;
}

/** Single file diff response */
export interface SessionSingleFileDiffResponse {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "unchanged";
	oldPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
	patch: string;
}

// ============================================================================
// Service Types
// ============================================================================

/** Service status representing the lifecycle of a service */
export type ServiceStatus = "running" | "stopped" | "starting" | "stopping";

/** Service represents a user-defined service in the sandbox */
export interface Service {
	/** Filename in .octobot/services/ */
	id: string;
	/** Display name (from config or id) */
	name: string;
	/** Description from config */
	description?: string;
	/** HTTP port if http service */
	http?: number;
	/** HTTPS port if https service */
	https?: number;
	/** Absolute path to service file */
	path: string;
	/** Default URL path for web preview (e.g., "/app") */
	urlPath?: string;
	/** Current status */
	status: ServiceStatus;
	/**
	 * Whether this is a passive service (external HTTP endpoint).
	 * Passive services are not started/stopped - they just declare an HTTP port.
	 */
	passive?: boolean;
	/** Process ID if running */
	pid?: number;
	/** ISO timestamp when started */
	startedAt?: string;
	/** Exit code if stopped after running */
	exitCode?: number;
}

/** Response from listing services */
export interface ListServicesResponse {
	services: Service[];
}

/** Response from starting a service */
export interface StartServiceResponse {
	status: "starting";
	serviceId: string;
}

/** Response from stopping a service */
export interface StopServiceResponse {
	status: "stopped";
	serviceId: string;
}

/** Service output event from SSE stream */
export interface ServiceOutputEvent {
	type: "stdout" | "stderr" | "exit" | "error";
	data?: string;
	exitCode?: number;
	error?: string;
	timestamp: string;
}

// ============================================================================
// UI Types
// ============================================================================

/** Active view type in the main panel - includes chat, terminal, services, and file paths */
export type ActiveView =
	| "chat"
	| "terminal"
	| `service:${string}`
	| `file:${string}`;
