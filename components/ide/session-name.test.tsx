import assert from "node:assert";
import { describe, it } from "node:test";
import { render, screen } from "@testing-library/react";
import type { Session } from "@/lib/api-types";
import { getSessionDisplayName, SessionName } from "./session-name";

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
		render(<SessionName session={session} />);

		const nameElement = screen.getByText("Original session name");
		assert.ok(nameElement);
	});

	it("should render displayName when set", () => {
		const session = createMockSession(
			"Original session name",
			"Custom Display Name",
		);
		render(<SessionName session={session} />);

		const nameElement = screen.getByText("Custom Display Name");
		assert.ok(nameElement);
	});

	it("should not render original name text when displayName is set", () => {
		const session = createMockSession(
			"Original session name",
			"Custom Display Name",
		);
		render(<SessionName session={session} />);

		// The original name should not be directly visible (it's in a tooltip)
		const originalNameElements = screen.queryAllByText("Original session name");
		// It might appear in tooltip, but shouldn't be the main displayed text
		assert.ok(
			originalNameElements.length === 0 ||
				originalNameElements.every(
					(el) => el.closest('[role="tooltip"]') !== null,
				),
		);
	});

	it("should apply custom className", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<SessionName session={session} className="custom-class" />,
		);

		const element = container.querySelector(".custom-class");
		assert.ok(element);
	});

	it("should apply custom textClassName", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<SessionName session={session} textClassName="custom-text-class" />,
		);

		const element = container.querySelector(".custom-text-class");
		assert.ok(element);
	});

	it("should render with icon when showIcon is true", () => {
		const session = createMockSession("Test session");
		const { container } = render(<SessionName session={session} showIcon />);

		// Check that there's an icon container
		const spans = container.querySelectorAll("span");
		// Should have at least: outer container, icon container, and text
		assert.ok(spans.length >= 3);
	});

	it("should not render icon when showIcon is false", () => {
		const session = createMockSession("Test session");
		const { container } = render(
			<SessionName session={session} showIcon={false} />,
		);

		// Without icon, should have fewer span elements
		const spans = container.querySelectorAll("span");
		// Should have: outer container and text (no icon container)
		assert.ok(spans.length < 3);
	});

	it("should handle long names correctly", () => {
		const longName = "A".repeat(100);
		const session = createMockSession(longName);
		render(<SessionName session={session} />);

		const nameElement = screen.getByText(longName);
		assert.ok(nameElement);
	});

	it("should handle special characters in names", () => {
		const specialName = "Test <>&\"' Session";
		const session = createMockSession(specialName);
		render(<SessionName session={session} />);

		const nameElement = screen.getByText(specialName);
		assert.ok(nameElement);
	});
});
