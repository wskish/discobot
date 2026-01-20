/**
 * Workspace Selection Test
 *
 * Tests that the workspace dropdown in ChatPanel updates correctly
 * when handleAddSession is called (e.g., clicking "+" on a workspace in sidebar).
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/workspace-selection.test.tsx
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { SWRConfig } from "swr";
import { DialogProvider } from "../../lib/contexts/dialog-context.js";
import {
	SessionProvider,
	useSessionContext,
} from "../../lib/contexts/session-context.js";
import { ChatPanel } from "./chat-panel.js";

// Mock workspace data
const mockWorkspaces = [
	{
		id: "ws-1",
		path: "/home/user/project-one",
		sourceType: "local" as const,
		status: "ready" as const,
		sessions: [],
	},
	{
		id: "ws-2",
		path: "/home/user/project-two",
		sourceType: "local" as const,
		status: "ready" as const,
		sessions: [],
	},
	{
		id: "ws-3",
		path: "https://github.com/org/repo",
		sourceType: "git" as const,
		status: "ready" as const,
		sessions: [],
	},
];

const mockAgents = [
	{
		id: "agent-1",
		name: "Test Agent",
		agentType: "claude-code",
		isDefault: true,
	},
];

const mockAgentTypes = [
	{
		id: "claude-code",
		name: "Claude Code",
		icons: [],
		modes: [{ id: "default", name: "Default" }],
		models: [{ id: "claude-3", name: "Claude 3" }],
	},
];

// Store original fetch
const originalFetch = globalThis.fetch;

// Mock fetch to return our test data
function setupMockFetch() {
	globalThis.fetch = async (url: RequestInfo | URL, options?: RequestInit) => {
		const urlStr = url.toString();

		// Return mock data based on URL patterns
		if (urlStr.includes("/workspaces")) {
			return new Response(JSON.stringify({ workspaces: mockWorkspaces }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (urlStr.includes("/agents/types")) {
			return new Response(JSON.stringify({ agentTypes: mockAgentTypes }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (urlStr.includes("/agents")) {
			return new Response(JSON.stringify({ agents: mockAgents }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (urlStr.includes("/credentials")) {
			return new Response(JSON.stringify({ credentials: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		if (urlStr.includes("/auth-providers")) {
			return new Response(JSON.stringify({ providers: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Default empty response for other API calls
		if (urlStr.includes("/api")) {
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		return originalFetch(url, options);
	};
}

function restoreFetch() {
	globalThis.fetch = originalFetch;
}

// Component that exposes session context actions for testing
function SessionActionTrigger({
	onReady,
}: {
	onReady: (actions: {
		handleAddSession: (workspaceId: string) => void;
	}) => void;
}) {
	const { handleAddSession } = useSessionContext();

	React.useEffect(() => {
		onReady({ handleAddSession });
	}, [handleAddSession, onReady]);

	return null;
}

// Wrapper component that provides all necessary contexts with mock data
function TestWrapper({
	children,
	onSessionReady,
}: {
	children: React.ReactNode;
	onSessionReady?: (actions: {
		handleAddSession: (workspaceId: string) => void;
	}) => void;
}) {
	return (
		<SWRConfig
			value={{
				provider: () => new Map(),
				dedupingInterval: 0,
				revalidateOnFocus: false,
				revalidateOnReconnect: false,
			}}
		>
			<SessionProvider>
				<DialogProvider>
					{onSessionReady && <SessionActionTrigger onReady={onSessionReady} />}
					{children}
				</DialogProvider>
			</SessionProvider>
		</SWRConfig>
	);
}

describe("Workspace Selection", () => {
	beforeEach(() => {
		setupMockFetch();
	});

	afterEach(() => {
		cleanup();
		restoreFetch();
	});

	test("workspace dropdown updates when handleAddSession is called", async () => {
		let sessionActions: { handleAddSession: (workspaceId: string) => void };

		render(
			<TestWrapper
				onSessionReady={(actions) => {
					sessionActions = actions;
				}}
			>
				<ChatPanel />
			</TestWrapper>,
		);

		// Wait for initial render and data loading
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});

		// Find the workspace dropdown button - it should show first workspace initially
		// The dropdown is in the welcome screen selectors area
		const workspaceButton = await waitFor(() => {
			// Look for a button that contains workspace-related content
			const buttons = screen.getAllByRole("button");
			const wsButton = buttons.find(
				(btn) =>
					btn.textContent?.includes("project-one") ||
					btn.textContent?.includes("Select workspace"),
			);
			if (!wsButton) {
				throw new Error("Workspace button not found");
			}
			return wsButton;
		});

		// Verify initial state shows first workspace (project-one)
		// The display path should show "~" prefix since it's /home/user/...
		const initialText = workspaceButton.textContent;
		console.log(`[test] Initial workspace button text: "${initialText}"`);

		// Now simulate clicking "+" on workspace 2 (project-two)
		// This calls handleAddSession which should update the selection
		await act(async () => {
			sessionActions.handleAddSession("ws-2");
		});

		// Wait for state update
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// Verify the dropdown now shows the second workspace (project-two)
		await waitFor(() => {
			const updatedText = workspaceButton.textContent;
			console.log(`[test] Updated workspace button text: "${updatedText}"`);
			assert.ok(
				updatedText?.includes("project-two"),
				`Expected workspace button to show "project-two" but got "${updatedText}"`,
			);
		});
	});

	test("workspace dropdown shows full path in title attribute", async () => {
		render(
			<TestWrapper>
				<ChatPanel />
			</TestWrapper>,
		);

		// Wait for initial render and data loading
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});

		// Find the workspace dropdown area that should have title with full path
		await waitFor(() => {
			const elementsWithTitle = document.querySelectorAll("[title]");
			const wsElement = Array.from(elementsWithTitle).find((el) =>
				el.getAttribute("title")?.includes("/home/user/project-one"),
			);
			assert.ok(
				wsElement,
				"Expected to find element with full path in title attribute",
			);
		});
	});

	test("handleAddSession with different workspace updates selection correctly", async () => {
		let sessionActions: { handleAddSession: (workspaceId: string) => void };

		render(
			<TestWrapper
				onSessionReady={(actions) => {
					sessionActions = actions;
				}}
			>
				<ChatPanel />
			</TestWrapper>,
		);

		// Wait for initial render
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
		});

		// Switch to git workspace (ws-3)
		await act(async () => {
			sessionActions.handleAddSession("ws-3");
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});

		// Verify the git workspace is now selected (should show org/repo)
		await waitFor(() => {
			const buttons = screen.getAllByRole("button");
			const wsButton = buttons.find(
				(btn) =>
					btn.textContent?.includes("org/repo") ||
					btn.textContent?.includes("github"),
			);
			assert.ok(
				wsButton,
				"Expected workspace button to show git repo after handleAddSession",
			);
		});
	});
});
