// API Client for making requests to the backend
import { getApiBase } from "./api-config";
import type {
	Agent,
	ChatMessage,
	CodexAuthorizeResponse,
	CodexExchangeRequest,
	CodexExchangeResponse,
	CreateAgentRequest,
	CreateCredentialRequest,
	CreateSessionRequest,
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

		if (!response.ok) {
			const error = await response
				.json()
				.catch(() => ({ error: "Request failed" }));
			throw new Error(error.error || "Request failed");
		}

		return response.json();
	}

	// Workspaces
	async getWorkspaces(): Promise<Workspace[]> {
		return this.fetch<Workspace[]>("/workspaces");
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

	async deleteWorkspace(id: string): Promise<void> {
		await this.fetch(`/workspaces/${id}`, { method: "DELETE" });
	}

	// Sessions
	async getSessions(workspaceId: string): Promise<Session[]> {
		return this.fetch<Session[]>(`/workspaces/${workspaceId}/sessions`);
	}

	async getSession(id: string): Promise<Session> {
		return this.fetch<Session>(`/sessions/${id}`);
	}

	async createSession(
		workspaceId: string,
		data: CreateSessionRequest,
	): Promise<Session> {
		return this.fetch<Session>(`/workspaces/${workspaceId}/sessions`, {
			method: "POST",
			body: JSON.stringify(data),
		});
	}

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
	async getSessionFiles(sessionId: string): Promise<FileNode[]> {
		return this.fetch<FileNode[]>(`/sessions/${sessionId}/files`);
	}

	async getFile(id: string): Promise<FileNode> {
		return this.fetch<FileNode>(`/files/${id}`);
	}

	// Messages
	async getMessages(sessionId: string): Promise<ChatMessage[]> {
		return this.fetch<ChatMessage[]>(`/sessions/${sessionId}/messages`);
	}

	// Agents
	async getAgents(): Promise<Agent[]> {
		return this.fetch<Agent[]>("/agents");
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

	async getTerminalHistory(): Promise<
		{ type: "input" | "output"; content: string }[]
	> {
		return this.fetch("/terminal/history");
	}

	// Suggestions
	async getSuggestions(
		query: string,
		type?: "path" | "repo",
	): Promise<Suggestion[]> {
		const params = new URLSearchParams({ q: query });
		if (type) params.set("type", type);
		return this.fetch<Suggestion[]>(`/suggestions?${params}`);
	}

	// Credentials
	async getCredentials(): Promise<CredentialInfo[]> {
		return this.fetch<CredentialInfo[]>("/credentials");
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
	async anthropicAuthorize(
		mode: "max" | "console" = "max",
	): Promise<OAuthAuthorizeResponse> {
		return this.fetch<OAuthAuthorizeResponse>(
			"/credentials/anthropic/authorize",
			{
				method: "POST",
				body: JSON.stringify({ mode }),
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
