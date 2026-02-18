import assert from "node:assert";
import { describe, it } from "node:test";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Session } from "@/lib/api-types";
import { getSessionDisplayName, SessionName } from "./session-name";

function TestWrapper({ children }: { children: React.ReactNode }) {
	return <TooltipProvider>{children}</TooltipProvider>;
}

// Mock session data
const createMockSession = (name: string, displayName?: string): Session => ({
	id: "test-session-id",
	name,
	displayName,
	description: "Test description",
	timestamp: "2024-01-01T00:00:00Z",
	status: "ready",
	files: [],
});

describe("getSessionDisplayName", () => {
	it("should return original name when displayName is not set", () => {
		const session = createMockSession("Original session name");
		const result = getSessionDisplayName(session);
		assert.strictEqual(result, "Original session name");
	});

	it("should return displayName when set", () => {
		const session = createMockSession(
			"Original session name",
			"Custom Display Name",
		);
		const result = getSessionDisplayName(session);
		assert.strictEqual(result, "Custom Display Name");
	});

	it("should return original name when displayName is empty string", () => {
		const session = createMockSession("Original session name", "");
		const result = getSessionDisplayName(session);
		// Empty string is falsy, so should fall back to original name
		assert.strictEqual(result, "Original session name");
	});
});

describe("SessionName", () => {
	it("should render original name when displayName is not set", () => {
		const session = createMockSession("Original session name");
		render(
			<TestWrapper>
				<SessionName session={session} />
			</TestWrapper>,
		);

		const nameElement = screen.getByText("Original session name");
		assert.ok(nameElement);
	});

	it("should render displayName when set", () => {
		const session = createMockSession(
			"Original session name",
			"Custom Display Name",
		);
		render(
			<TestWrapper>
				<SessionName session={session} />
			</TestWrapper>,
		);

		const nameElement = screen.getByText("Custom Display Name");
		assert.ok(nameElement);
	});

	it("should not render original name text when displayName is set", () => {
		const session = createMockSession(
			"Original session name",
			"Custom Display Name",
		);
		const { container } = render(
			<TestWrapper>
				<SessionName session={session} />
			</TestWrapper>,
		);

		// The original name should not appear in the primary component container
		// (it only appears in the Radix tooltip portal which renders into document.body)
		assert.ok(
			!container.textContent?.includes("Original session name"),
			"Original session name should not appear in the component container",
		);
	});

	it("should apply custom className", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<TestWrapper>
				<SessionName session={session} className="custom-class" />
			</TestWrapper>,
		);

		const element = container.querySelector(".custom-class");
		assert.ok(element);
	});

	it("should apply custom textClassName", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<TestWrapper>
				<SessionName session={session} textClassName="custom-text-class" />
			</TestWrapper>,
		);

		const element = container.querySelector(".custom-text-class");
		assert.ok(element);
	});

	it("should render with icon when showIcon is true", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<TestWrapper>
				<SessionName session={session} showIcon />
			</TestWrapper>,
		);

		// Check that there's an icon container
		const spans = container.querySelectorAll("span");
		// Should have at least: outer container, icon container, and text
		assert.ok(spans.length >= 3);
	});

	it("should not render icon when showIcon is false", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<TestWrapper>
				<SessionName session={session} showIcon={false} />
			</TestWrapper>,
		);

		// Without icon, should have fewer span elements
		const spans = container.querySelectorAll("span");
		// Should have: outer container and text (no icon container)
		assert.ok(spans.length < 3);
	});

	it("should handle long names correctly", () => {
		const longName = "A".repeat(100);
		const session = createMockSession(longName);
		render(
			<TestWrapper>
				<SessionName session={session} />
			</TestWrapper>,
		);

		const nameElement = screen.getByText(longName);
		assert.ok(nameElement);
	});

	it("should handle special characters in names", () => {
		const specialName = "Test <>&\"' Session";
		const session = createMockSession(specialName);
		render(
			<TestWrapper>
				<SessionName session={session} />
			</TestWrapper>,
		);

		const nameElement = screen.getByText(specialName);
		assert.ok(nameElement);
	});
});
