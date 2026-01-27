/**
 * WorkspaceDisplay Component Test
 *
 * Tests that the WorkspaceDisplay component correctly renders workspace icons and names,
 * respects displayName property, and shows appropriate tooltips.
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/workspace-display.test.tsx
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import type { Workspace } from "../../lib/api-types.js";
import { WorkspaceDisplay } from "./workspace-display.js";

// Mock TooltipProvider for testing
function TestWrapper({ children }: { children: React.ReactNode }) {
	return <div>{children}</div>;
}

describe("WorkspaceDisplay Component", () => {
	afterEach(() => {
		cleanup();
	});

	test("renders workspace with displayName when set", () => {
		const workspace: Workspace = {
			id: "ws-1",
			path: "/home/user/very-long-project-name",
			sourceType: "local" as const,
			status: "ready" as const,
			displayName: "My Project",
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} />
			</TestWrapper>,
		);

		// Should display the custom displayName, not the path
		const text = container.textContent;
		assert.ok(
			text?.includes("My Project"),
			`Expected to display "My Project" but got "${text}"`,
		);
		assert.ok(
			!text?.includes("very-long-project-name"),
			"Should not display path when displayName is set",
		);
	});

	test("renders workspace with parsed path when no displayName", () => {
		const workspace: Workspace = {
			id: "ws-2",
			path: "/home/user/project-one",
			sourceType: "local" as const,
			status: "ready" as const,
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} />
			</TestWrapper>,
		);

		// Should display shortened path (~/project-one)
		const text = container.textContent;
		assert.ok(
			text?.includes("project-one"),
			`Expected to display path but got "${text}"`,
		);
	});

	test("renders GitHub repository correctly", () => {
		const workspace: Workspace = {
			id: "ws-3",
			path: "https://github.com/octocat/hello-world",
			sourceType: "git" as const,
			status: "ready" as const,
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} />
			</TestWrapper>,
		);

		// Should display as "octocat/hello-world"
		const text = container.textContent;
		assert.ok(
			text?.includes("octocat/hello-world"),
			`Expected to display "octocat/hello-world" but got "${text}"`,
		);
	});

	test("applies custom className", () => {
		const workspace: Workspace = {
			id: "ws-4",
			path: "/test",
			sourceType: "local" as const,
			status: "ready" as const,
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} className="custom-class" />
			</TestWrapper>,
		);

		const divElement = container.querySelector(".custom-class");
		assert.ok(divElement, "Expected custom className to be applied");
	});

	test("applies custom text className", () => {
		const workspace: Workspace = {
			id: "ws-5",
			path: "/test",
			sourceType: "local" as const,
			status: "ready" as const,
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} textClassName="text-custom" />
			</TestWrapper>,
		);

		const spanElement = container.querySelector(".text-custom");
		assert.ok(spanElement, "Expected custom text className to be applied");
	});

	test("renders icon and text in correct structure", () => {
		const workspace: Workspace = {
			id: "ws-6",
			path: "/test/path",
			sourceType: "local" as const,
			status: "ready" as const,
		};

		const { container } = render(
			<TestWrapper>
				<WorkspaceDisplay workspace={workspace} />
			</TestWrapper>,
		);

		// Should have container with gap-1.5 and min-w-0
		const containerDiv = container.querySelector(".gap-1\\.5");
		assert.ok(containerDiv, "Expected container with gap-1.5 class");

		// Should have an icon (svg element)
		const icon = container.querySelector("svg");
		assert.ok(icon, "Expected to find icon SVG element");

		// Should have text span with truncate class
		const textSpan = container.querySelector(".truncate");
		assert.ok(textSpan, "Expected to find text span with truncate class");
	});

	test("displayName takes precedence over path for all workspace types", () => {
		const workspaces: Workspace[] = [
			{
				id: "ws-local",
				path: "/home/user/project",
				sourceType: "local" as const,
				status: "ready" as const,
				displayName: "Local Custom",
			},
			{
				id: "ws-git",
				path: "https://github.com/org/repo",
				sourceType: "git" as const,
				status: "ready" as const,
				displayName: "Git Custom",
			},
		];

		for (const workspace of workspaces) {
			const { container, unmount } = render(
				<TestWrapper>
					<WorkspaceDisplay workspace={workspace} />
				</TestWrapper>,
			);

			const text = container.textContent;
			assert.ok(
				text?.includes(workspace.displayName || ""),
				`Expected displayName for ${workspace.sourceType} workspace`,
			);
			assert.ok(
				!text?.includes(workspace.sourceType === "local" ? "project" : "org"),
				`Should not show path when displayName is set for ${workspace.sourceType}`,
			);

			unmount();
		}
	});
});
