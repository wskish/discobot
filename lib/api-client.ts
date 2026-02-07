// API Client for making requests to the backend
import { appendAuthToken, getApiBase, getApiRootBase } from "./api-config";

/** Error thrown when file write fails due to optimistic locking conflict */
export class FileConflictError extends Error {
	constructor(
		message: string,
		public currentContent: string,
	) {
		super(message);
		this.name = "FileConflictError";
	}
}

import type {
	Agent,
	AuthProvider,
	CancelChatResponse,
	ChatMessage,
	CodexAuthorizeResponse,
	CodexExchangeRequest,
	CodexExchangeResponse,
	CreateAgentRequest,
	CreateCredentialRequest,
	CreateWorkspaceRequest,
	CredentialInfo,
	GitHubCopilotDeviceCodeRequest,
	GitHubCopilotDeviceCodeResponse,
	GitHubCopilotPollRequest,
	GitHubCopilotPollResponse,
	ListServicesResponse,
	ListSessionFilesResponse,
	OAuthAuthorizeResponse,
	OAuthExchangeRequest,
	OAuthExchangeResponse,
	ProviderStatus,
	ProvidersResponse,
	ReadSessionFileResponse,
	Session,
	SessionDiffFilesResponse,
	SessionDiffResponse,
	SessionSingleFileDiffResponse,
	StartServiceResponse,
	StopServiceResponse,
	Suggestion,
	SupportedAgentType,
	SystemStatusResponse,
	TerminalExecuteResponse,
	UpdateAgentRequest,
	UpdateSessionRequest,
	UserPreference,
	Workspace,
	WriteSessionFileRequest,
	WriteSessionFileResponse,
} from "./api-types";

class ApiClient {
	// Use getters to get current base URL (may change after Tauri init)
	private get base() {
		return getApiBase();
	}
	private get rootBase() {
		return getApiRootBase();
	}

	private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
		const response = await fetch(appendAuthToken(`${this.base}${path}`), {
			...options,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});

		// Treat 404 as success for DELETE requests (resource already gone)
		if (options?.method === "DELETE" && response.status === 404) {
			return undefined as T;
		}

		if (!response.ok) {
			const error = await response
				.json()
				.catch(() => ({ error: "Request failed" }));
			throw new Error(error.error || "Request failed");
		}

		return response.json();
	}

	// Fetch from root API (not project-scoped)
	private async fetchRoot<T>(path: string, options?: RequestInit): Promise<T> {
		const response = await fetch(appendAuthToken(`${this.rootBase}${path}`), {
			...options,
			headers: {
				"Content-Type": "application/json",
				...options?.headers,
			},
		});

		if (!response.ok) {
			const error = await response
				.json()
				.catch(() => ({ error: "Request failed" }));
			throw new Error(error.error || "Request failed");
		}

		return response.json();
	}

	// System Status
	async getSystemStatus(): Promise<SystemStatusResponse> {
		return this.fetchRoot<SystemStatusResponse>("/status");
	}

	// Providers
	async getProviders(): Promise<ProvidersResponse> {
		return this.fetch<ProvidersResponse>("/workspaces/providers");
	}

	async getProvider(name: string): Promise<ProviderStatus> {
		return this.fetch<ProviderStatus>(`/workspaces/providers/${name}`);
	}

	// Workspaces

	async getWorkspaces(): Promise<{ workspaces: Workspace[] }> {
		return this.fetch<{ workspaces: Workspace[] }>("/workspaces");
	}

	async getWorkspace(id: string): Promise<Workspace> {
		return this.fetch<Workspace>(`/workspaces/${id}`);
	}

	async createWorkspace(data: CreateWorkspaceRequest): Promise<Workspace> {
		return this.fetch<Workspace>("/workspaces", {
			method: "POST",
			body: JSON.stringify(data),
		});
	}

	async updateWorkspace(
		id: string,
		data: { path?: string; displayName?: string | null },
	): Promise<Workspace> {
		return this.fetch<Workspace>(`/workspaces/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		});
	}

	async deleteWorkspace(id: string, deleteFiles = false): Promise<void> {
		const params = deleteFiles ? "?deleteFiles=true" : "";
		await this.fetch(`/workspaces/${id}${params}`, { method: "DELETE" });
	}

	// Sessions
	async getSessions(
		workspaceId: string,
		options?: { includeClosed?: boolean },
	): Promise<{ sessions: Session[] }> {
		const params = new URLSearchParams();
		if (options?.includeClosed) {
			params.set("includeClosed", "true");
		}
		const query = params.toString();
		return this.fetch<{ sessions: Session[] }>(
			`/workspaces/${workspaceId}/sessions${query ? `?${query}` : ""}`,
		);
	}

	async getSession(id: string): Promise<Session> {
		return this.fetch<Session>(`/sessions/${id}`);
	}

	// NOTE: createSession removed - sessions are created implicitly via /chat endpoint

	async updateSession(
		id: string,
		data: UpdateSessionRequest,
	): Promise<Session> {
		return this.fetch<Session>(`/sessions/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		});
	}

	async deleteSession(id: string): Promise<void> {
		await this.fetch(`/sessions/${id}`, { method: "DELETE" });
	}

	async commitSession(id: string): Promise<{ success: boolean }> {
		return this.fetch<{ success: boolean }>(`/sessions/${id}/commit`, {
			method: "POST",
		});
	}

	// Session Files
	/**
	 * List files in a session's workspace directory.
	 * @param sessionId Session ID
	 * @param path Directory path relative to workspace root (defaults to ".")
	 * @param includeHidden Whether to include hidden files (starting with ".")
	 */
	async listSessionFiles(
		sessionId: string,
		path = ".",
		includeHidden = false,
	): Promise<ListSessionFilesResponse> {
		const params = new URLSearchParams({ path });
		if (includeHidden) params.set("hidden", "true");
		return this.fetch<ListSessionFilesResponse>(
			`/sessions/${sessionId}/files?${params}`,
		);
	}

	/**
	 * Read a file from a session's workspace.
	 * @param sessionId Session ID
	 * @param path File path relative to workspace root
	 * @param options.fromBase If true, read from base commit (for deleted files)
	 */
	async readSessionFile(
		sessionId: string,
		path: string,
		options?: { fromBase?: boolean },
	): Promise<ReadSessionFileResponse> {
		const params = new URLSearchParams({ path });
		if (options?.fromBase) {
			params.set("fromBase", "true");
		}
		return this.fetch<ReadSessionFileResponse>(
			`/sessions/${sessionId}/files/read?${params}`,
		);
	}

	/**
	 * Write a file to a session's workspace.
	 * @param sessionId Session ID
	 * @param data File content and path (include originalContent for optimistic locking)
	 * @throws {FileConflictError} When originalContent doesn't match current file content
	 */
	async writeSessionFile(
		sessionId: string,
		data: WriteSessionFileRequest,
	): Promise<WriteSessionFileResponse> {
		const response = await fetch(
			`${this.base}/sessions/${sessionId}/files/write`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			},
		);

		const result = await response.json();

		if (!response.ok) {
			// Check for conflict error (optimistic locking failure)
			if (response.status === 409 && result.error === "conflict") {
				throw new FileConflictError(
					result.message || "File has been modified",
					result.currentContent,
				);
			}
			throw new Error(result.error || "Request failed");
		}

		return result;
	}

	/**
	 * Get diff for a session's workspace.
	 * @param sessionId Session ID
	 * @param options.path Single file path for file-specific diff
	 * @param options.format "files" for file list only, undefined for full diff
	 */
	async getSessionDiff(
		sessionId: string,
		options?: { path?: string; format?: "files" },
	): Promise<
		| SessionDiffResponse
		| SessionDiffFilesResponse
		| SessionSingleFileDiffResponse
	> {
		const params = new URLSearchParams();
		if (options?.path) params.set("path", options.path);
		if (options?.format) params.set("format", options.format);
		const query = params.toString();
		return this.fetch(`/sessions/${sessionId}/diff${query ? `?${query}` : ""}`);
	}

	// Messages
	async getMessages(sessionId: string): Promise<{ messages: ChatMessage[] }> {
		return this.fetch<{ messages: ChatMessage[] }>(
			`/sessions/${sessionId}/messages`,
		);
	}

	/**
	 * Get the URL for resuming an in-progress chat stream via SSE.
	 * Returns SSE stream if completion is in progress, 204 No Content if not.
	 * @param sessionId Session ID
	 */
	getChatStreamUrl(sessionId: string): string {
		return appendAuthToken(`${this.base}/chat/${sessionId}/stream`);
	}

	/**
	 * Cancel an in-progress chat completion.
	 * @param sessionId Session ID
	 */
	async cancelChat(sessionId: string): Promise<CancelChatResponse> {
		return this.fetch(`/chat/${sessionId}/cancel`, {
			method: "POST",
		});
	}

	// Agents
	async getAgents(): Promise<{ agents: Agent[] }> {
		return this.fetch<{ agents: Agent[] }>("/agents");
	}

	async getAgent(id: string): Promise<Agent> {
		return this.fetch<Agent>(`/agents/${id}`);
	}

	async createAgent(data: CreateAgentRequest): Promise<Agent> {
		return this.fetch<Agent>("/agents", {
			method: "POST",
			body: JSON.stringify(data),
		});
	}

	async updateAgent(id: string, data: UpdateAgentRequest): Promise<Agent> {
		return this.fetch<Agent>(`/agents/${id}`, {
			method: "PUT",
			body: JSON.stringify(data),
		});
	}

	async deleteAgent(id: string): Promise<void> {
		await this.fetch(`/agents/${id}`, { method: "DELETE" });
	}

	async setDefaultAgent(id: string): Promise<Agent> {
		return this.fetch<Agent>("/agents/default", {
			method: "POST",
			body: JSON.stringify({ agentId: id }),
		});
	}

	async getAgentTypes(): Promise<{ agentTypes: SupportedAgentType[] }> {
		return this.fetch("/agents/types");
	}

	async getAuthProviders(): Promise<{ authProviders: AuthProvider[] }> {
		return this.fetch("/agents/auth-providers");
	}

	// Terminal
	async executeCommand(
		command: string,
		sessionId?: string,
	): Promise<TerminalExecuteResponse> {
		return this.fetch<TerminalExecuteResponse>("/terminal/execute", {
			method: "POST",
			body: JSON.stringify({ command, sessionId }),
		});
	}

	async getTerminalHistory(): Promise<{
		history: { type: "input" | "output"; content: string }[];
	}> {
		return this.fetch("/terminal/history");
	}

	// Suggestions
	async getSuggestions(
		query: string,
		type?: "path" | "repo",
	): Promise<{ suggestions: Suggestion[] }> {
		const params = new URLSearchParams({ q: query });
		if (type) params.set("type", type);
		return this.fetch<{ suggestions: Suggestion[] }>(`/suggestions?${params}`);
	}

	// Credentials
	async getCredentials(): Promise<{ credentials: CredentialInfo[] }> {
		return this.fetch<{ credentials: CredentialInfo[] }>("/credentials");
	}

	async createCredential(
		data: CreateCredentialRequest,
	): Promise<CredentialInfo> {
		return this.fetch<CredentialInfo>("/credentials", {
			method: "POST",
			body: JSON.stringify(data),
		});
	}

	async deleteCredential(providerId: string): Promise<void> {
		await this.fetch(`/credentials/${providerId}`, { method: "DELETE" });
	}

	// Anthropic OAuth
	async anthropicAuthorize(): Promise<OAuthAuthorizeResponse> {
		return this.fetch<OAuthAuthorizeResponse>(
			"/credentials/anthropic/authorize",
			{
				method: "POST",
			},
		);
	}

	async anthropicExchange(
		data: OAuthExchangeRequest,
	): Promise<OAuthExchangeResponse> {
		return this.fetch<OAuthExchangeResponse>(
			"/credentials/anthropic/exchange",
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		);
	}

	// GitHub Copilot OAuth (device flow)
	async githubCopilotDeviceCode(
		data: GitHubCopilotDeviceCodeRequest = {},
	): Promise<GitHubCopilotDeviceCodeResponse> {
		return this.fetch<GitHubCopilotDeviceCodeResponse>(
			"/credentials/github-copilot/device-code",
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		);
	}

	async githubCopilotPoll(
		data: GitHubCopilotPollRequest,
	): Promise<GitHubCopilotPollResponse> {
		return this.fetch<GitHubCopilotPollResponse>(
			"/credentials/github-copilot/poll",
			{
				method: "POST",
				body: JSON.stringify(data),
			},
		);
	}

	// Codex (ChatGPT) OAuth
	async codexAuthorize(): Promise<CodexAuthorizeResponse> {
		return this.fetch<CodexAuthorizeResponse>("/credentials/codex/authorize", {
			method: "POST",
		});
	}

	async codexExchange(
		data: CodexExchangeRequest,
	): Promise<CodexExchangeResponse> {
		return this.fetch<CodexExchangeResponse>("/credentials/codex/exchange", {
			method: "POST",
			body: JSON.stringify(data),
		});
	}

	// Services
	/**
	 * List all services in a session's sandbox.
	 * @param sessionId Session ID
	 */
	async getServices(sessionId: string): Promise<ListServicesResponse> {
		return this.fetch<ListServicesResponse>(`/sessions/${sessionId}/services`);
	}

	/**
	 * Start a service in a session's sandbox.
	 * @param sessionId Session ID
	 * @param serviceId Service ID (filename in .discobot/services/)
	 */
	async startService(
		sessionId: string,
		serviceId: string,
	): Promise<StartServiceResponse> {
		return this.fetch<StartServiceResponse>(
			`/sessions/${sessionId}/services/${serviceId}/start`,
			{ method: "POST" },
		);
	}

	/**
	 * Stop a service in a session's sandbox.
	 * @param sessionId Session ID
	 * @param serviceId Service ID (filename in .discobot/services/)
	 */
	async stopService(
		sessionId: string,
		serviceId: string,
	): Promise<StopServiceResponse> {
		return this.fetch<StopServiceResponse>(
			`/sessions/${sessionId}/services/${serviceId}/stop`,
			{ method: "POST" },
		);
	}

	/**
	 * Get the URL for streaming service output via SSE.
	 * Use with EventSource to receive real-time output.
	 * @param sessionId Session ID
	 * @param serviceId Service ID (filename in .discobot/services/)
	 */
	getServiceOutputUrl(sessionId: string, serviceId: string): string {
		return appendAuthToken(
			`${this.base}/sessions/${sessionId}/services/${serviceId}/output`,
		);
	}

	// User Preferences (user-scoped, not project-scoped)

	/**
	 * Get all preferences for the current user.
	 */
	async getPreferences(): Promise<{ preferences: UserPreference[] }> {
		return this.fetchRoot<{ preferences: UserPreference[] }>("/preferences");
	}

	/**
	 * Get a single preference by key.
	 * @param key Preference key
	 */
	async getPreference(key: string): Promise<UserPreference> {
		return this.fetchRoot<UserPreference>(`/preferences/${key}`);
	}

	/**
	 * Set a single preference.
	 * @param key Preference key
	 * @param value Preference value
	 */
	async setPreference(key: string, value: string): Promise<UserPreference> {
		return this.fetchRoot<UserPreference>(`/preferences/${key}`, {
			method: "PUT",
			body: JSON.stringify({ value }),
		});
	}

	/**
	 * Set multiple preferences at once.
	 * @param preferences Map of key-value pairs
	 */
	async setPreferences(
		preferences: Record<string, string>,
	): Promise<{ preferences: UserPreference[] }> {
		return this.fetchRoot<{ preferences: UserPreference[] }>("/preferences", {
			method: "PUT",
			body: JSON.stringify({ preferences }),
		});
	}

	/**
	 * Delete a preference by key.
	 * @param key Preference key
	 */
	async deletePreference(key: string): Promise<void> {
		await this.fetchRoot(`/preferences/${key}`, { method: "DELETE" });
	}
}

export const api = new ApiClient();
