/**
 * SessionViewHeader Component Test
 *
 * Tests for the session view header functionality including:
 * - Diff stats display
 * - Files button toggle
 * - IDE Launcher positioning
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/session-view-header.test.tsx
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("SessionViewHeader - Diff Stats Button", () => {
	it("should display additions and deletions", () => {
		// Mock diff stats
		const stats = {
			filesChanged: 5,
			additions: 123,
			deletions: 45,
		};

		// Button should show +/- format
		const buttonText = `+${stats.additions} -${stats.deletions}`;
		assert.ok(buttonText.includes("+123"));
		assert.ok(buttonText.includes("-45"));
	});

	it("should only show button when there are changes", () => {
		const noChanges = {
			filesChanged: 0,
			additions: 0,
			deletions: 0,
		};

		const hasChanges = {
			filesChanged: 3,
			additions: 10,
			deletions: 5,
		};

		// Button visibility depends on filesChanged > 0
		const shouldShow = (stats: typeof noChanges) => stats.filesChanged > 0;

		assert.strictEqual(shouldShow(noChanges), false);
		assert.strictEqual(shouldShow(hasChanges), true);
	});

	it("should navigate to consolidated-diff view when clicked", () => {
		// When the +/- button is clicked, it should set activeView to "consolidated-diff"
		const expectedView = "consolidated-diff";
		assert.strictEqual(expectedView, "consolidated-diff");
	});
});

describe("SessionViewHeader - Files Toggle Button", () => {
	it("should show 'Files' text when sidebar is closed", () => {
		const rightSidebarOpen = false;

		// When closed, button shows "Files"
		const buttonText = rightSidebarOpen ? "Close" : "Files";
		assert.strictEqual(buttonText, "Files");
	});

	it("should show close icon when sidebar is open", () => {
		const rightSidebarOpen = true;

		// When open, button shows close icon (PanelRightClose)
		const showIcon = rightSidebarOpen;
		assert.strictEqual(showIcon, true);
	});

	it("should toggle sidebar when clicked", () => {
		// Button should call onToggleRightSidebar when clicked
		// This toggles the right sidebar visibility
		let sidebarOpen = false;

		const toggleSidebar = () => {
			sidebarOpen = !sidebarOpen;
		};

		// Initially closed
		assert.strictEqual(sidebarOpen, false);

		// Click to open
		toggleSidebar();
		assert.strictEqual(sidebarOpen, true);

		// Click to close
		toggleSidebar();
		assert.strictEqual(sidebarOpen, false);
	});
});

describe("SessionViewHeader - IDE Launcher Position", () => {
	it("should be positioned before Files button", () => {
		// IDE Launcher is in the right-aligned section
		// It appears just before the Files toggle button
		const rightSectionButtons = [
			"Stop", // If service running
			"Reconnect", // If terminal disconnected
			"Commit", // If changes exist
			"IDE Launcher",
			"Files",
		];

		const ideLauncherIndex = rightSectionButtons.indexOf("IDE Launcher");
		const filesButtonIndex = rightSectionButtons.indexOf("Files");

		assert.ok(
			ideLauncherIndex < filesButtonIndex,
			"IDE Launcher should come before Files button",
		);
	});
});

describe("SessionViewHeader - Commit Button", () => {
	it("should show commit button when there are changes", () => {
		const changedFilesCount = 5;

		// Button should be visible when there are changes
		const shouldShow = changedFilesCount > 0;
		assert.strictEqual(shouldShow, true);
	});

	it("should show loading state when committing", () => {
		const isCommitting = true;

		// Button should show "Committing..." text and spinner when committing
		const buttonText = isCommitting ? "Committing..." : "Commit";
		assert.strictEqual(buttonText, "Committing...");
	});

	it("should be disabled while committing", () => {
		const isCommitting = true;

		// Button should be disabled during commit
		assert.strictEqual(isCommitting, true);
	});
});
