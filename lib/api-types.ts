// API Types - shared between client and server

export interface FileNode {
	id: string;
	name: string;
	type: "file" | "folder";
	children?: FileNode[];
	content?: string;
	originalContent?: string;
	changed?: boolean;
}

export interface Session {
	id: string;
	name: string;
	description: string;
	timestamp: string;
	status: "open" | "running" | "closed";
	files: FileNode[];
	workspaceId?: string;
	agentId?: string;
}

export interface Workspace {
	id: string;
	name: string;
	path: string;
	sourceType: "local" | "git";
	sessions: Session[];
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

export interface SupportedAgentType {
	id: string;
	name: string;
	description: string;
	icons?: Icon[];
	modes?: AgentMode[];
	models?: AgentModel[];
	/** Auth provider IDs this agent supports (e.g., "anthropic", "openai", "codex") */
	supportedAuthProviders?: string[];
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

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	turn: number;
}

export interface Suggestion {
	value: string;
	type: "path" | "repo";
}

// API Request/Response types
export interface CreateWorkspaceRequest {
	path: string;
	sourceType: "local" | "git";
}

export interface CreateSessionRequest {
	name: string;
	agentId: string;
}

export interface UpdateSessionRequest {
	name?: string;
	status?: Session["status"];
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
