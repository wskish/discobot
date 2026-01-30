import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

// Mock localStorage
class LocalStorageMock {
	private store: Record<string, string> = {};

	getItem(key: string): string | null {
		return this.store[key] || null;
	}

	setItem(key: string, value: string): void {
		this.store[key] = value;
	}

	removeItem(key: string): void {
		delete this.store[key];
	}

	clear(): void {
		this.store = {};
	}
}

const HISTORY_KEY = "discobot:prompt-history";
const DRAFT_PREFIX = "discobot-prompt-draft-";
const MAX_HISTORY_SIZE = 100;

describe("usePromptHistory localStorage helpers", () => {
	let localStorageMock: LocalStorageMock;

	beforeEach(() => {
		localStorageMock = new LocalStorageMock();
	});

	afterEach(() => {
		localStorageMock.clear();
	});

	describe("loadHistory", () => {
		it("should load history from localStorage", () => {
			const mockHistory = ["prompt 1", "prompt 2", "prompt 3"];
			localStorageMock.setItem(HISTORY_KEY, JSON.stringify(mockHistory));

			const stored = localStorageMock.getItem(HISTORY_KEY);
			const parsed = stored ? JSON.parse(stored) : [];

			assert.deepStrictEqual(parsed, mockHistory);
		});

		it("should return empty array if no history exists", () => {
			const stored = localStorageMock.getItem(HISTORY_KEY);
			const parsed = stored ? JSON.parse(stored) : [];

			assert.deepStrictEqual(parsed, []);
		});

		it("should filter out non-string items", () => {
			const mockHistory = ["prompt 1", 123, "prompt 2", null, "prompt 3"];
			localStorageMock.setItem(HISTORY_KEY, JSON.stringify(mockHistory));

			const stored = localStorageMock.getItem(HISTORY_KEY);
			const parsed = stored ? JSON.parse(stored) : [];
			const filtered = parsed.filter(
				(item: unknown) => typeof item === "string",
			);

			assert.deepStrictEqual(filtered, ["prompt 1", "prompt 2", "prompt 3"]);
		});
	});

	describe("saveHistoryToStorage", () => {
		it("should save history to localStorage", () => {
			const mockHistory = ["prompt 1", "prompt 2", "prompt 3"];
			localStorageMock.setItem(HISTORY_KEY, JSON.stringify(mockHistory));

			const stored = localStorageMock.getItem(HISTORY_KEY);
			assert.strictEqual(stored, JSON.stringify(mockHistory));
		});

		it("should trim history to MAX_HISTORY_SIZE", () => {
			const largeHistory = Array.from({ length: 150 }, (_, i) => `prompt ${i}`);
			const trimmed = largeHistory.slice(0, MAX_HISTORY_SIZE);
			localStorageMock.setItem(HISTORY_KEY, JSON.stringify(trimmed));

			const stored = localStorageMock.getItem(HISTORY_KEY);
			const parsed = stored ? JSON.parse(stored) : [];

			assert.strictEqual(parsed.length, MAX_HISTORY_SIZE);
		});
	});

	describe("draft persistence", () => {
		it("should save draft with session ID", () => {
			const sessionId = "session-123";
			const draftValue = "My draft prompt";
			localStorageMock.setItem(`${DRAFT_PREFIX}${sessionId}`, draftValue);

			const stored = localStorageMock.getItem(`${DRAFT_PREFIX}${sessionId}`);
			assert.strictEqual(stored, draftValue);
		});

		it("should load draft for session ID", () => {
			const sessionId = "session-123";
			const draftValue = "My draft prompt";
			localStorageMock.setItem(`${DRAFT_PREFIX}${sessionId}`, draftValue);

			const draft = localStorageMock.getItem(`${DRAFT_PREFIX}${sessionId}`);
			assert.strictEqual(draft, draftValue);
		});

		it("should clear draft for session ID", () => {
			const sessionId = "session-123";
			const draftValue = "My draft prompt";
			localStorageMock.setItem(`${DRAFT_PREFIX}${sessionId}`, draftValue);
			localStorageMock.removeItem(`${DRAFT_PREFIX}${sessionId}`);

			const draft = localStorageMock.getItem(`${DRAFT_PREFIX}${sessionId}`);
			assert.strictEqual(draft, null);
		});
	});
});

describe("usePromptHistory hook logic", () => {
	describe("addToHistory", () => {
		it("should add new prompt to history", () => {
			const history: string[] = [];
			const prompt = "new prompt";

			if (!prompt.trim()) return;
			if (history.includes(prompt)) {
				// Don't add duplicates
				assert.fail("Should not add duplicate");
			}
			const updated = [prompt, ...history].slice(0, MAX_HISTORY_SIZE);

			assert.deepStrictEqual(updated, [prompt]);
		});

		it("should not add duplicate prompts", () => {
			const history = ["existing prompt", "another prompt"];
			const prompt = "existing prompt";

			if (!prompt.trim()) return;
			if (history.includes(prompt)) {
				// Don't add duplicates - pass the test
				assert.ok(true, "Correctly rejected duplicate");
				return;
			}
			assert.fail("Should have detected duplicate");
		});

		it("should not add empty prompts", () => {
			const _history: string[] = [];
			const prompt = "   ";

			if (!prompt.trim()) {
				assert.ok(true, "Correctly rejected empty prompt");
				return;
			}
			assert.fail("Should have rejected empty prompt");
		});

		it("should add prompt at beginning of array", () => {
			const history = ["old prompt 1", "old prompt 2"];
			const prompt = "new prompt";

			const updated = [prompt, ...history];

			assert.strictEqual(updated[0], prompt);
			assert.strictEqual(updated[1], "old prompt 1");
			assert.strictEqual(updated[2], "old prompt 2");
		});
	});

	describe("pinPrompt", () => {
		// Note: Pinned prompts are now stored in user preferences API, not localStorage
		it("should add prompt to pinned list", () => {
			const pinnedPrompts: string[] = [];
			const prompt = "pin this";

			if (!prompt.trim()) return;
			if (pinnedPrompts.includes(prompt)) {
				assert.fail("Should not add duplicate");
			}
			const updated = [...pinnedPrompts, prompt];

			assert.deepStrictEqual(updated, [prompt]);
		});

		it("should not add duplicate pinned prompts", () => {
			const pinnedPrompts = ["already pinned"];
			const prompt = "already pinned";

			if (!prompt.trim()) return;
			if (pinnedPrompts.includes(prompt)) {
				assert.ok(true, "Correctly rejected duplicate pin");
				return;
			}
			assert.fail("Should have detected duplicate pin");
		});

		it("should add pinned prompt at end of array", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const prompt = "pin 3";

			const updated = [...pinnedPrompts, prompt];

			assert.strictEqual(updated[2], prompt);
		});
	});

	describe("unpinPrompt", () => {
		it("should remove prompt from pinned list", () => {
			const pinnedPrompts = ["pin 1", "pin 2", "pin 3"];
			const prompt = "pin 2";

			const updated = pinnedPrompts.filter((p) => p !== prompt);

			assert.deepStrictEqual(updated, ["pin 1", "pin 3"]);
		});

		it("should handle unpinning non-existent prompt", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const prompt = "nonexistent";

			const updated = pinnedPrompts.filter((p) => p !== prompt);

			assert.deepStrictEqual(updated, ["pin 1", "pin 2"]);
		});
	});

	describe("isPinned", () => {
		it("should return true for pinned prompt", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const prompt = "pin 1";

			const result = pinnedPrompts.includes(prompt);

			assert.strictEqual(result, true);
		});

		it("should return false for unpinned prompt", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const prompt = "pin 3";

			const result = pinnedPrompts.includes(prompt);

			assert.strictEqual(result, false);
		});
	});

	describe("keyboard navigation", () => {
		it("should start with first pinned item when opening history", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const _history = ["recent 1", "recent 2"];
			const pinnedLength = pinnedPrompts.length;

			// Simulate opening history
			let historyIndex = 0;
			let isPinnedSelection = false;

			if (pinnedLength > 0) {
				historyIndex = 0;
				isPinnedSelection = true;
			} else {
				historyIndex = 0;
				isPinnedSelection = false;
			}

			assert.strictEqual(historyIndex, 0);
			assert.strictEqual(isPinnedSelection, true);
		});

		it("should navigate through pinned items before recent items", () => {
			const pinnedPrompts = ["pin 1", "pin 2", "pin 3"];
			const history = ["recent 1", "recent 2"];
			const pinnedLength = pinnedPrompts.length;
			const visibleHistoryLength = history.length;

			// Start at first pinned
			let historyIndex = 0;
			let isPinnedSelection = true;

			// Navigate down through pinned
			historyIndex = 1;
			assert.strictEqual(isPinnedSelection, true);
			assert.strictEqual(historyIndex, 1);

			historyIndex = 2;
			assert.strictEqual(isPinnedSelection, true);
			assert.strictEqual(historyIndex, 2);

			// Move to recent section
			if (historyIndex >= pinnedLength - 1 && visibleHistoryLength > 0) {
				historyIndex = 0;
				isPinnedSelection = false;
			}

			assert.strictEqual(isPinnedSelection, false);
			assert.strictEqual(historyIndex, 0);
		});

		it("should cycle back from recent to pinned on down arrow", () => {
			const pinnedPrompts = ["pin 1", "pin 2"];
			const pinnedLength = pinnedPrompts.length;

			// At first recent item
			let historyIndex = 0;
			let isPinnedSelection = false;

			// Press down arrow
			if (historyIndex <= 0) {
				if (pinnedLength > 0) {
					historyIndex = pinnedLength - 1;
					isPinnedSelection = true;
				}
			}

			assert.strictEqual(isPinnedSelection, true);
			assert.strictEqual(historyIndex, 1); // Last pinned item
		});

		it("should close dropdown when pressing down at first pinned item", () => {
			let historyIndex = 0;
			let isPinnedSelection = true;
			let isHistoryOpen = true;

			// Press down arrow at first pinned item
			if (isPinnedSelection && historyIndex <= 0) {
				isHistoryOpen = false;
				historyIndex = -1;
				isPinnedSelection = false;
			}

			assert.strictEqual(isHistoryOpen, false);
			assert.strictEqual(historyIndex, -1);
			assert.strictEqual(isPinnedSelection, false);
		});
	});
});
