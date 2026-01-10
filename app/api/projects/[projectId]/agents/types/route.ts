import { NextResponse } from "next/server";
import type { SupportedAgentType } from "@/lib/api-types";

const supportedAgentTypes: SupportedAgentType[] = [
	{
		id: "claude-code",
		name: "Claude Code",
		description:
			"Anthropic's Claude optimized for coding tasks with agentic capabilities",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23D97757' d='M4.709 15.955l4.72-2.647.08-.08 1.44-2.559-2.08 1.28c-.4.24-.88.24-1.28-.08l-2.88-2.24 2.96 6.326zm8.17-7.144l1.52-2.879-2.24.96c-.32.16-.72.08-1.04-.16L8.399 4.092l4.48 4.72zm-7.37 10.39l6.08-3.439c.24-.16.56-.16.8 0l6.08 3.44-6.08-12.88c-.16-.32-.48-.56-.8-.56s-.64.16-.8.48l-6.08 12.96zM21.347 17.355l-8.56-18.24c-.32-.64-1.04-1.04-1.76-1.04-.8 0-1.44.4-1.76 1.04L.707 17.355c-.32.72-.24 1.52.24 2.16.48.64 1.2 1.04 2 1.04h16.16c.8 0 1.52-.4 2-1.04.48-.64.56-1.44.24-2.16z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
		modes: [
			{
				id: "code",
				name: "Code",
				description: "Focused on writing and editing code",
			},
			{
				id: "architect",
				name: "Architect",
				description: "High-level design and planning",
			},
			{
				id: "ask",
				name: "Ask",
				description: "Answer questions without making changes",
			},
		],
		models: [
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
			{
				id: "claude-opus-4-20250514",
				name: "Claude Opus 4",
				provider: "Anthropic",
			},
			{
				id: "claude-3-5-haiku-20241022",
				name: "Claude 3.5 Haiku",
				provider: "Anthropic",
			},
		],
	},
	{
		id: "opencode",
		name: "OpenCode",
		description:
			"Open source AI coding agent supporting multiple LLM providers",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%2310B981' d='M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' stroke='%2310B981' stroke-width='2' fill='none'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
		modes: [
			{
				id: "build",
				name: "Build",
				description: "Build and implement features",
			},
			{ id: "plan", name: "Plan", description: "Plan without making changes" },
		],
		models: [
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
			{ id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
			{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
			{ id: "deepseek-v3", name: "DeepSeek V3", provider: "DeepSeek" },
		],
	},
	{
		id: "gemini-cli",
		name: "Gemini CLI",
		description: "Google's Gemini model as a command-line coding assistant",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='gemini' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' style='stop-color:%234285F4'/%3E%3Cstop offset='50%25' style='stop-color:%239B72CB'/%3E%3Cstop offset='100%25' style='stop-color:%23D96570'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23gemini)' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
		modes: [
			{ id: "code", name: "Code", description: "Write and edit code" },
			{ id: "chat", name: "Chat", description: "General conversation" },
		],
		models: [
			{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
			{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google" },
		],
	},
	{
		id: "aider",
		name: "Aider",
		description: "AI pair programming in your terminal with git integration",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%2300D4AA' d='M12 2L2 7l10 5 10-5-10-5zm0 15l-10-5v5l10 5 10-5v-5l-10 5z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
			},
		],
		modes: [
			{ id: "code", name: "Code", description: "Edit files directly" },
			{ id: "ask", name: "Ask", description: "Ask questions without editing" },
			{
				id: "architect",
				name: "Architect",
				description: "High-level design mode",
			},
		],
		models: [
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
			{ id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
			{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "DeepSeek" },
			{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "Google" },
		],
	},
	{
		id: "continue",
		name: "Continue",
		description: "Open-source AI code assistant with IDE integration",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23000000' d='M8 5v14l11-7z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "light",
			},
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23FFFFFF' d='M8 5v14l11-7z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "dark",
			},
		],
		modes: [
			{ id: "chat", name: "Chat", description: "Interactive conversation" },
			{ id: "edit", name: "Edit", description: "Edit selected code" },
		],
		models: [
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
			{ id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
			{ id: "codellama-70b", name: "Code Llama 70B", provider: "Meta" },
		],
	},
	{
		id: "cursor-agent",
		name: "Cursor Agent",
		description: "AI-powered coding agent from Cursor IDE",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23000000' d='M13.64 21.97C13.14 22.21 12.54 22 12.31 21.5L2.31 4.5C2.1 4.1 2.18 3.59 2.5 3.29C2.82 2.99 3.3 2.95 3.69 3.19L20.19 14.19C20.56 14.43 20.73 14.89 20.6 15.31C20.47 15.73 20.07 16 19.64 16H14.89L13.64 21.97Z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "light",
			},
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23FFFFFF' d='M13.64 21.97C13.14 22.21 12.54 22 12.31 21.5L2.31 4.5C2.1 4.1 2.18 3.59 2.5 3.29C2.82 2.99 3.3 2.95 3.69 3.19L20.19 14.19C20.56 14.43 20.73 14.89 20.6 15.31C20.47 15.73 20.07 16 19.64 16H14.89L13.64 21.97Z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "dark",
			},
		],
		modes: [
			{ id: "agent", name: "Agent", description: "Autonomous coding agent" },
			{ id: "normal", name: "Normal", description: "Standard chat mode" },
		],
		models: [
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
			{ id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
			{ id: "cursor-small", name: "Cursor Small", provider: "Cursor" },
		],
	},
	{
		id: "codex",
		name: "OpenAI Codex CLI",
		description: "OpenAI's code-specialized model for terminal use",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23000000' d='M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "light",
			},
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23FFFFFF' d='M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "dark",
			},
		],
		modes: [
			{ id: "auto", name: "Auto", description: "Automatic mode selection" },
			{
				id: "full-auto",
				name: "Full Auto",
				description: "Fully autonomous mode",
			},
		],
		models: [
			{ id: "o3", name: "o3", provider: "OpenAI" },
			{ id: "o4-mini", name: "o4-mini", provider: "OpenAI" },
			{ id: "gpt-4.1", name: "GPT-4.1", provider: "OpenAI" },
		],
	},
	{
		id: "copilot-cli",
		name: "GitHub Copilot CLI",
		description: "GitHub Copilot for command-line interactions",
		icons: [
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23000000' d='M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "light",
			},
			{
				src: "data:image/svg+xml,%3Csvg viewBox='0 0 24 24' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23FFFFFF' d='M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z'/%3E%3C/svg%3E",
				mimeType: "image/svg+xml",
				sizes: ["any"],
				theme: "dark",
			},
		],
		modes: [
			{
				id: "suggest",
				name: "Suggest",
				description: "Get command suggestions",
			},
			{ id: "explain", name: "Explain", description: "Explain commands" },
		],
		models: [
			{ id: "gpt-4o", name: "GPT-4o", provider: "OpenAI" },
			{
				id: "claude-sonnet-4-20250514",
				name: "Claude Sonnet 4",
				provider: "Anthropic",
			},
		],
	},
];

export async function GET() {
	return NextResponse.json({
		agentTypes: supportedAgentTypes,
	});
}
