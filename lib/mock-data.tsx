// Types for the IDE sidebar tree structure
export interface FileNode {
	id: string;
	name: string;
	type: "file" | "folder";
	children?: FileNode[];
	content?: string;
	originalContent?: string; // For diff view (renamed from oldContent for consistency)
	changed?: boolean; // Added flag to indicate if file has changes
}

export interface Session {
	id: string;
	name: string;
	description: string;
	timestamp: string;
	status: "open" | "running" | "closed";
	files: FileNode[];
}

export interface Workspace {
	id: string;
	name: string;
	path: string;
	sourceType: "local" | "git";
	sessions: Session[];
}

// Types for agents
export interface Agent {
	id: string;
	name: string;
	description: string;
	status: "active" | "inactive";
}

// Mock agents
export const mockAgents: Agent[] = [
	{
		id: "agent-1",
		name: "Code Assistant",
		description: "General purpose coding helper",
		status: "active",
	},
	{
		id: "agent-2",
		name: "Refactor Pro",
		description: "Specialized in code refactoring",
		status: "active",
	},
	{
		id: "agent-3",
		name: "Test Writer",
		description: "Generates unit and integration tests",
		status: "inactive",
	},
];

// Mock workspaces with sessions and files
export const mockWorkspaces: Workspace[] = [
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
								changed: true, // Mark as changed
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
								changed: false, // Unchanged file
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

// Mock chat messages with turns
export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	turn: number;
}

export const mockChatMessages: ChatMessage[] = [
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
	{
		id: "msg-5",
		role: "user",
		content:
			"Great! Now update the middleware to use Supabase session handling.",
		turn: 3,
	},
	{
		id: "msg-6",
		role: "assistant",
		content: `Updated the middleware to use Supabase:

\`\`\`typescript
import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createMiddlewareClient({ req, res });
  await supabase.auth.getSession();
  return res;
}
\`\`\`

This middleware refreshes the session on each request, which is required for Supabase Auth to work properly with SSR.`,
		turn: 3,
	},
	{
		id: "msg-7",
		role: "user",
		content: "Finally, update the LoginForm component.",
		turn: 4,
	},
	{
		id: "msg-8",
		role: "assistant",
		content: `Here's the updated LoginForm component:

\`\`\`tsx
"use client";
import { useState } from "react";
import { signIn } from "@/src/auth";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await signIn(email, password);
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      <button type="submit">Sign In</button>
    </form>
  );
}
\`\`\`

The migration is complete! All three files have been updated to use Supabase Auth instead of NextAuth.`,
		turn: 4,
	},
];

export const mockTerminalLines = [
	{ type: "input" as const, content: "ssh user@dev-server.local" },
	{
		type: "output" as const,
		content:
			"Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)",
	},
	{
		type: "output" as const,
		content: "Last login: Thu Jan 9 10:23:45 2026 from 192.168.1.100",
	},
	{ type: "input" as const, content: "cd /var/www/my-app" },
	{ type: "input" as const, content: "git status" },
	{
		type: "output" as const,
		content:
			"On branch main\nYour branch is up to date with 'origin/main'.\n\nChanges not staged for commit:\n  modified:   src/auth.ts\n  modified:   src/middleware.ts",
	},
	{ type: "input" as const, content: "npm run build" },
	{
		type: "output" as const,
		content:
			"▲ Next.js 15.1.0\n\n   Creating an optimized production build ...\n   ✓ Compiled successfully\n   ✓ Linting and checking validity of types\n   ✓ Collecting page data\n   ✓ Generating static pages (4/4)\n   ✓ Finalizing page optimization\n\nRoute (app)                              Size     First Load JS\n┌ ○ /                                    5.2 kB        92.1 kB\n├ ○ /login                               2.1 kB        89.0 kB\n└ ○ /dashboard                           8.4 kB        95.3 kB\n\n✓ Build completed in 12.3s",
	},
	{ type: "input" as const, content: "pm2 restart all" },
	{
		type: "output" as const,
		content:
			"[PM2] Applying action restartProcessId on app [all](ids: 0,1)\n[PM2] [my-app](0) ✓\n[PM2] [my-app](1) ✓",
	},
];
