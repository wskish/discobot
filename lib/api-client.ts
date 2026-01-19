// API Client for making requests to the backend
import { getApiBase } from "./api-config";
import type {
	Agent,
	AuthProvider,
	ChatMessage,
	CodexAuthorizeResponse,
	CodexExchangeRequest,
	CodexExchangeResponse,
	CreateAgentRequest,
	CreateCredentialRequest,
	CreateWorkspaceRequest,
	CredentialInfo,
	FileNode,
	GitHubCopilotDeviceCodeRequest,
	GitHubCopilotDeviceCodeResponse,
	GitHubCopilotPollRequest,
	GitHubCopilotPollResponse,
	OAuthAuthorizeResponse,
	OAuthExchangeRequest,
	OAuthExchangeResponse,
	Session,
	Suggestion,
	SupportedAgentType,
	SystemStatusResponse,
	TerminalExecuteResponse,
	UpdateAgentRequest,
	UpdateSessionRequest,
	Workspace,
} from "./api-types";

class ApiClient {
	private base = getApiBase();

	private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
		const response = await fetch(`${this.base}${path}`, {
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
		const response = await fetch(`/api${path}`, {
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
		data: Partial<Workspace>,
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
	async getSessions(workspaceId: string): Promise<{ sessions: Session[] }> {
		return this.fetch<{ sessions: Session[] }>(
			`/workspaces/${workspaceId}/sessions`,
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

	// Files
	async getSessionFiles(sessionId: string): Promise<{ files: FileNode[] }> {
		return this.fetch<{ files: FileNode[] }>(`/sessions/${sessionId}/files`);
	}

	async getFile(id: string): Promise<FileNode> {
		return this.fetch<FileNode>(`/files/${id}`);
	}

	// Messages
	async getMessages(sessionId: string): Promise<{ messages: ChatMessage[] }> {
		return this.fetch<{ messages: ChatMessage[] }>(
			`/sessions/${sessionId}/messages`,
		);
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
}

export const api = new ApiClient();
