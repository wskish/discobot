// Mock database for API routes
import type {
	Agent,
	ChatMessage,
	CreateAgentRequest,
	CreateCredentialRequest,
	CreateSessionRequest,
	CreateWorkspaceRequest,
	Credential,
	CredentialInfo,
	FileNode,
	Session,
	Suggestion,
	TerminalExecuteResponse,
	UpdateAgentRequest,
	UpdateSessionRequest,
	Workspace,
} from "./api-types";

// In-memory storage (resets on server restart)
const workspaces: Workspace[] = [
	{
		id: "ws-1",
		name: "my-app",
		path: "~/projects/my-app",
		sourceType: "local",
		sessions: [
			{
				id: "session-1",
				name: "Refactor auth flow",
				description: "Migrating from NextAuth to Supabase auth",
				timestamp: "2 hours ago",
				status: "running",
				workspaceId: "ws-1",
				agentId: "agent-1",
				files: [
					{
						id: "folder-1",
						name: "src",
						type: "folder",
						children: [
							{
								id: "file-1",
								name: "auth.ts",
								type: "file",
								changed: true,
								originalContent: `import NextAuth from "next-auth";\nimport GitHub from "next-auth/providers/github";\n\nexport const { auth, handlers } = NextAuth({\n  providers: [GitHub],\n});`,
								content: `import { createClient } from "@supabase/supabase-js";\n\nconst supabase = createClient(\n  process.env.SUPABASE_URL!,\n  process.env.SUPABASE_ANON_KEY!\n);\n\nexport async function signIn(email: string, password: string) {\n  return supabase.auth.signInWithPassword({ email, password });\n}\n\nexport async function signOut() {\n  return supabase.auth.signOut();\n}`,
							},
							{
								id: "file-2",
								name: "middleware.ts",
								type: "file",
								changed: true,
								originalContent: `export { auth as middleware } from "./auth";`,
								content: `import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";\nimport { NextResponse } from "next/server";\nimport type { NextRequest } from "next/server";\n\nexport async function middleware(req: NextRequest) {\n  const res = NextResponse.next();\n  const supabase = createMiddlewareClient({ req, res });\n  await supabase.auth.getSession();\n  return res;\n}`,
							},
							{
								id: "file-7",
								name: "utils.ts",
								type: "file",
								changed: false,
								content: `export function cn(...classes: string[]) {\n  return classes.filter(Boolean).join(" ");\n}`,
							},
						],
					},
					{
						id: "folder-2",
						name: "components",
						type: "folder",
						children: [
							{
								id: "file-3",
								name: "login-form.tsx",
								type: "file",
								changed: true,
								originalContent: `"use client";\nimport { signIn } from "next-auth/react";\n\nexport function LoginForm() {\n  return (\n    <button onClick={() => signIn("github")}>\n      Sign in with GitHub\n    </button>\n  );\n}`,
								content: `"use client";\nimport { useState } from "react";\nimport { signIn } from "@/src/auth";\n\nexport function LoginForm() {\n  const [email, setEmail] = useState("");\n  const [password, setPassword] = useState("");\n\n  const handleSubmit = async (e: React.FormEvent) => {\n    e.preventDefault();\n    await signIn(email, password);\n  };\n\n  return (\n    <form onSubmit={handleSubmit}>\n      <input\n        type="email"\n        value={email}\n        onChange={(e) => setEmail(e.target.value)}\n        placeholder="Email"\n      />\n      <input\n        type="password"\n        value={password}\n        onChange={(e) => setPassword(e.target.value)}\n        placeholder="Password"\n      />\n      <button type="submit">Sign In</button>\n    </form>\n  );\n}`,
							},
							{
								id: "file-8",
								name: "button.tsx",
								type: "file",
								changed: false,
								content: `export function Button({ children }: { children: React.ReactNode }) {\n  return <button className="btn">{children}</button>;\n}`,
							},
						],
					},
					{
						id: "file-9",
						name: "package.json",
						type: "file",
						changed: false,
						content: `{\n  "name": "my-app",\n  "version": "1.0.0"\n}`,
					},
				],
			},
			{
				id: "session-2",
				name: "Add dark mode",
				description: "Implementing theme switching with next-themes",
				timestamp: "Yesterday",
				status: "closed",
				workspaceId: "ws-1",
				agentId: "agent-2",
				files: [
					{
						id: "file-4",
						name: "theme-provider.tsx",
						type: "file",
						changed: true,
						content: `"use client";\nimport { ThemeProvider as NextThemesProvider } from "next-themes";\n\nexport function ThemeProvider({ children }: { children: React.ReactNode }) {\n  return (\n    <NextThemesProvider attribute="class" defaultTheme="system">\n      {children}\n    </NextThemesProvider>\n  );\n}`,
					},
				],
			},
		],
	},
	{
		id: "ws-2",
		name: "acme-ui",
		path: "github.com/acme/acme-ui",
		sourceType: "git",
		sessions: [
			{
				id: "session-3",
				name: "Fix button variants",
				description: "Adding outline and ghost variants to Button component",
				timestamp: "3 days ago",
				status: "open",
				workspaceId: "ws-2",
				agentId: "agent-3",
				files: [
					{
						id: "folder-3",
						name: "components",
						type: "folder",
						children: [
							{
								id: "file-5",
								name: "button.tsx",
								type: "file",
								changed: true,
								originalContent: `import { cn } from "@/lib/utils";\n\nexport function Button({ children, className }) {\n  return (\n    <button className={cn("px-4 py-2 bg-primary text-white rounded", className)}>\n      {children}\n    </button>\n  );\n}`,
								content: `import { cn } from "@/lib/utils";\nimport { cva, type VariantProps } from "class-variance-authority";\n\nconst buttonVariants = cva(\n  "px-4 py-2 rounded font-medium transition-colors",\n  {\n    variants: {\n      variant: {\n        default: "bg-primary text-white hover:bg-primary/90",\n        outline: "border border-primary text-primary hover:bg-primary/10",\n        ghost: "text-primary hover:bg-primary/10",\n      },\n    },\n    defaultVariants: {\n      variant: "default",\n    },\n  }\n);\n\nexport function Button({ children, className, variant }: VariantProps<typeof buttonVariants> & { children: React.ReactNode; className?: string }) {\n  return (\n    <button className={cn(buttonVariants({ variant }), className)}>\n      {children}\n    </button>\n  );\n}`,
							},
							{
								id: "file-10",
								name: "card.tsx",
								type: "file",
								changed: false,
								content: `export function Card({ children }: { children: React.ReactNode }) {\n  return <div className="card">{children}</div>;\n}`,
							},
						],
					},
				],
			},
			{
				id: "session-4",
				name: "Setup CI pipeline",
				description: "Adding GitHub Actions for tests and deployment",
				timestamp: "1 week ago",
				status: "closed",
				workspaceId: "ws-2",
				agentId: "agent-1",
				files: [
					{
						id: "folder-4",
						name: ".github",
						type: "folder",
						children: [
							{
								id: "folder-5",
								name: "workflows",
								type: "folder",
								children: [
									{
										id: "file-6",
										name: "ci.yml",
										type: "file",
										changed: true,
										content: `name: CI\n\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci\n      - run: npm test`,
									},
								],
							},
						],
					},
				],
			},
		],
	},
];

// Start with empty agents to show welcome modal on first load
// Uncomment below for development with pre-populated agents:
// const agents: Agent[] = [
// 	{
// 		id: "agent-1",
// 		name: "Code Assistant",
// 		description: "General purpose coding helper",
// 		agentType: "claude-code",
// 		isDefault: true,
// 	},
// 	{
// 		id: "agent-2",
// 		name: "Refactor Pro",
// 		description: "Specialized in code refactoring",
// 		agentType: "opencode",
// 	},
// 	{
// 		id: "agent-3",
// 		name: "Test Writer",
// 		description: "Generates unit and integration tests",
// 		agentType: "gemini-cli",
// 	},
// ];
const agents: Agent[] = [];

const chatMessages: Record<string, ChatMessage[]> = {
	"session-1": [
		{
			id: "msg-1",
			role: "user",
			content:
				"I need to refactor our authentication system from NextAuth to Supabase. Can you help me plan this migration?",
			turn: 1,
		},
		{
			id: "msg-2",
			role: "assistant",
			content: `I'll help you migrate from NextAuth to Supabase Auth. Here's a structured approach:

## Migration Plan

1. **Install Supabase packages**
\`\`\`bash
npm install @supabase/supabase-js @supabase/auth-helpers-nextjs
\`\`\`

2. **Update environment variables** - Replace NextAuth secrets with Supabase credentials

3. **Refactor auth utilities** - Replace the NextAuth config with Supabase client

4. **Update middleware** - Switch to Supabase session handling

5. **Migrate components** - Update login/signup forms to use Supabase methods

Should I start with the auth utility file?`,
			turn: 1,
		},
		{
			id: "msg-3",
			role: "user",
			content:
				"Yes, let's start with the auth.ts file. Show me the before and after.",
			turn: 2,
		},
		{
			id: "msg-4",
			role: "assistant",
			content: `Here's the refactored \`auth.ts\` file:

\`\`\`typescript
// Before (NextAuth)
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { auth, handlers } = NextAuth({
  providers: [GitHub],
});

// After (Supabase)
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}
\`\`\`

I've updated the file. The main changes:
- Replaced NextAuth with Supabase client
- Changed from OAuth-only to email/password auth
- Exported individual functions instead of the NextAuth object`,
			turn: 2,
		},
	],
};

const terminalHistory: { type: "input" | "output"; content: string }[] = [
	{ type: "input", content: "ssh user@dev-server.local" },
	{
		type: "output",
		content:
			"Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)",
	},
	{
		type: "output",
		content: "Last login: Thu Jan 9 10:23:45 2026 from 192.168.1.100",
	},
	{ type: "input", content: "cd /var/www/my-app" },
	{ type: "input", content: "git status" },
	{
		type: "output",
		content:
			"On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  modified:   src/auth.ts\n  modified:   src/middleware.ts",
	},
];

// Credentials storage (secrets stored server-side)
const credentials: Credential[] = [];

// Mock suggestions for autocomplete
const mockSuggestions = [
	{ value: "github.com/vercel/next.js", type: "repo" as const },
	{ value: "github.com/vercel/ai", type: "repo" as const },
	{ value: "github.com/facebook/react", type: "repo" as const },
	{ value: "github.com/microsoft/typescript", type: "repo" as const },
	{ value: "~/projects/my-app", type: "path" as const },
	{ value: "~/projects/website", type: "path" as const },
	{ value: "~/code/api-server", type: "path" as const },
	{ value: "/home/user/dev/dashboard", type: "path" as const },
];

// Helper functions
function findFileById(files: FileNode[], id: string): FileNode | null {
	for (const file of files) {
		if (file.id === id) return file;
		if (file.children) {
			const found = findFileById(file.children, id);
			if (found) return found;
		}
	}
	return null;
}

function findSessionById(
	id: string,
): { session: Session; workspace: Workspace } | null {
	for (const workspace of workspaces) {
		const session = workspace.sessions.find((s) => s.id === id);
		if (session) return { session, workspace };
	}
	return null;
}

// Database operations
export const db = {
	// Workspaces
	getWorkspaces(): Workspace[] {
		return workspaces;
	},

	getWorkspace(id: string): Workspace | null {
		return workspaces.find((w) => w.id === id) || null;
	},

	createWorkspace(data: CreateWorkspaceRequest): Workspace {
		const workspace: Workspace = {
			id: `ws-${Date.now()}`,
			name: data.path.split("/").pop() || data.path,
			path: data.path,
			sourceType: data.sourceType,
			sessions: [],
		};
		workspaces.push(workspace);
		return workspace;
	},

	updateWorkspace(id: string, data: Partial<Workspace>): Workspace | null {
		const index = workspaces.findIndex((w) => w.id === id);
		if (index === -1) return null;
		workspaces[index] = { ...workspaces[index], ...data };
		return workspaces[index];
	},

	deleteWorkspace(id: string): boolean {
		const index = workspaces.findIndex((w) => w.id === id);
		if (index === -1) return false;
		workspaces.splice(index, 1);
		return true;
	},

	// Sessions
	getSessions(workspaceId: string): Session[] {
		const workspace = workspaces.find((w) => w.id === workspaceId);
		return workspace?.sessions || [];
	},

	getSession(id: string): Session | null {
		const result = findSessionById(id);
		return result?.session || null;
	},

	createSession(
		workspaceId: string,
		data: CreateSessionRequest,
	): Session | null {
		const workspace = workspaces.find((w) => w.id === workspaceId);
		if (!workspace) return null;

		const session: Session = {
			id: `session-${Date.now()}`,
			name: data.name,
			description: data.name,
			timestamp: "Just now",
			status: "running",
			workspaceId: workspaceId,
			agentId: data.agentId,
			files: [],
		};
		workspace.sessions.unshift(session);
		return session;
	},

	updateSession(id: string, data: UpdateSessionRequest): Session | null {
		const result = findSessionById(id);
		if (!result) return null;

		const { session } = result;
		if (data.name !== undefined) session.name = data.name;
		if (data.status !== undefined) session.status = data.status;
		return session;
	},

	deleteSession(id: string): boolean {
		for (const workspace of workspaces) {
			const index = workspace.sessions.findIndex((s) => s.id === id);
			if (index !== -1) {
				workspace.sessions.splice(index, 1);
				return true;
			}
		}
		return false;
	},

	// Files
	getSessionFiles(sessionId: string): FileNode[] {
		const result = findSessionById(sessionId);
		return result?.session.files || [];
	},

	getFile(id: string): FileNode | null {
		for (const workspace of workspaces) {
			for (const session of workspace.sessions) {
				const file = findFileById(session.files, id);
				if (file) return file;
			}
		}
		return null;
	},

	// Messages
	getMessages(sessionId: string): ChatMessage[] {
		return chatMessages[sessionId] || [];
	},

	// Agents
	getAgents(): Agent[] {
		return agents;
	},

	getAgent(id: string): Agent | null {
		return agents.find((a) => a.id === id) || null;
	},

	createAgent(data: CreateAgentRequest): Agent {
		const agent: Agent = {
			id: `agent-${Date.now()}`,
			name: data.name,
			description: data.description,
			agentType: data.agentType,
			systemPrompt: data.systemPrompt,
			mcpServers: data.mcpServers,
		};
		agents.push(agent);
		return agent;
	},

	updateAgent(id: string, data: UpdateAgentRequest): Agent | null {
		const index = agents.findIndex((a) => a.id === id);
		if (index === -1) return null;
		agents[index] = { ...agents[index], ...data };
		return agents[index];
	},

	deleteAgent(id: string): boolean {
		const index = agents.findIndex((a) => a.id === id);
		if (index === -1) return false;
		agents.splice(index, 1);
		return true;
	},

	setDefaultAgent(id: string): Agent | null {
		const agent = agents.find((a) => a.id === id);
		if (!agent) return null;
		// Clear isDefault from all agents, then set it on the target
		for (const a of agents) {
			a.isDefault = a.id === id;
		}
		return agent;
	},

	// Terminal
	executeCommand(command: string): TerminalExecuteResponse {
		terminalHistory.push({ type: "input", content: command });

		// Simulate command output
		let output = `Command '${command}' executed successfully`;
		const exitCode = 0;

		if (command.startsWith("ls")) {
			output = "node_modules/  src/  package.json  tsconfig.json";
		} else if (command.startsWith("pwd")) {
			output = "/var/www/my-app";
		} else if (command.startsWith("echo")) {
			output = command.replace("echo ", "");
		} else if (command.startsWith("cat")) {
			output = "File contents would be displayed here...";
		} else if (command === "whoami") {
			output = "user";
		} else if (command === "date") {
			output = new Date().toString();
		}

		terminalHistory.push({ type: "output", content: output });

		return { output, exitCode };
	},

	getTerminalHistory(): { type: "input" | "output"; content: string }[] {
		return terminalHistory;
	},

	// Suggestions
	getSuggestions(query: string, type?: "path" | "repo"): Suggestion[] {
		const lower = query.toLowerCase();
		return mockSuggestions
			.filter((s) => {
				if (type && s.type !== type) return false;
				return s.value.toLowerCase().includes(lower);
			})
			.slice(0, 6);
	},

	// Credentials (returns safe info without secrets)
	getCredentials(): CredentialInfo[] {
		return credentials.map((c) => ({
			id: c.id,
			name: c.name,
			provider: c.provider,
			authType: c.authType,
			isConfigured: c.isConfigured,
			updatedAt: c.updatedAt,
		}));
	},

	getCredential(providerId: string): Credential | null {
		return credentials.find((c) => c.provider === providerId) || null;
	},

	getCredentialInfo(providerId: string): CredentialInfo | null {
		const cred = credentials.find((c) => c.provider === providerId);
		if (!cred) return null;
		return {
			id: cred.id,
			name: cred.name,
			provider: cred.provider,
			authType: cred.authType,
			isConfigured: cred.isConfigured,
			updatedAt: cred.updatedAt,
		};
	},

	createOrUpdateCredential(data: CreateCredentialRequest): CredentialInfo {
		const existing = credentials.find((c) => c.provider === data.provider);
		const now = new Date().toISOString();

		if (existing) {
			existing.authType = data.authType;
			existing.apiKey = data.apiKey;
			existing.oauthData = data.oauthData;
			existing.isConfigured = true;
			existing.updatedAt = now;
			return {
				id: existing.id,
				name: existing.name,
				provider: existing.provider,
				authType: existing.authType,
				isConfigured: existing.isConfigured,
				updatedAt: existing.updatedAt,
			};
		}

		const credential: Credential = {
			id: `cred-${Date.now()}`,
			name: data.provider,
			provider: data.provider,
			authType: data.authType,
			apiKey: data.apiKey,
			oauthData: data.oauthData,
			isConfigured: true,
			updatedAt: now,
		};
		credentials.push(credential);
		return {
			id: credential.id,
			name: credential.name,
			provider: credential.provider,
			authType: credential.authType,
			isConfigured: credential.isConfigured,
			updatedAt: credential.updatedAt,
		};
	},

	deleteCredential(providerId: string): boolean {
		const index = credentials.findIndex((c) => c.provider === providerId);
		if (index === -1) return false;
		credentials.splice(index, 1);
		return true;
	},
};
