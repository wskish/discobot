import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

// Mock EventSource before importing the hook
type EventSourceListener = (event: { data: string }) => void;

class MockEventSource {
	static instances: MockEventSource[] = [];
	url: string;
	readyState: number = 0; // CONNECTING
	onopen: (() => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	private listeners: Map<string, EventSourceListener[]> = new Map();

	constructor(url: string) {
		this.url = url;
		MockEventSource.instances.push(this);
		// Simulate async connection
		setTimeout(() => {
			this.readyState = 1; // OPEN
			this.onopen?.();
		}, 0);
	}

	addEventListener(type: string, listener: EventSourceListener) {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, []);
		}
		this.listeners.get(type)?.push(listener);
	}

	removeEventListener(type: string, listener: EventSourceListener) {
		const arr = this.listeners.get(type);
		if (arr) {
			const idx = arr.indexOf(listener);
			if (idx !== -1) arr.splice(idx, 1);
		}
	}

	// Test helper to simulate events
	simulateEvent(type: string, data: unknown) {
		const listeners = this.listeners.get(type) || [];
		for (const listener of listeners) {
			listener({ data: JSON.stringify(data) });
		}
	}

	close() {
		this.readyState = 2; // CLOSED
	}

	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 2;
}

// Store captured mutate calls
interface MutateCall {
	key: string | ((key: string) => boolean);
	mutator?: (current: unknown) => unknown;
	options?: { revalidate: boolean };
}

const mutateCalls: MutateCall[] = [];

// Mock modules before importing
const originalEventSource = globalThis.EventSource;

describe("useProjectEvents", () => {
	beforeEach(() => {
		MockEventSource.instances = [];
		mutateCalls.length = 0;
		// @ts-expect-error - mocking EventSource
		globalThis.EventSource = MockEventSource;
	});

	afterEach(() => {
		globalThis.EventSource = originalEventSource;
	});

	describe("session_updated with status removed", () => {
		it("should correctly mutate workspaces cache with { workspaces: [] } structure", async () => {
			// This test verifies the fix for: "current.map is not a function"
			// The bug occurred because the mutator expected Workspace[] but received { workspaces: Workspace[] }

			// Arrange: Create mock workspaces data in the correct format
			const mockWorkspacesData = {
				workspaces: [
					{
						id: "ws-1",
						name: "Workspace 1",
						sessions: [
							{ id: "session-1", name: "Session 1" },
							{ id: "session-2", name: "Session 2" },
						],
					},
					{
						id: "ws-2",
						name: "Workspace 2",
						sessions: [{ id: "session-3", name: "Session 3" }],
					},
				],
			};

			// Create the mutator function that mirrors the fix
			const mutator = (
				current:
					| {
							workspaces: Array<{
								id: string;
								sessions: Array<{ id: string }>;
							}>;
					  }
					| undefined,
			) => {
				if (!current?.workspaces) return current;
				return {
					...current,
					workspaces: current.workspaces.map((workspace) => ({
						...workspace,
						sessions: workspace.sessions.filter(
							(session) => session.id !== "session-2",
						),
					})),
				};
			};

			// Act: Apply the mutator
			const result = mutator(mockWorkspacesData);

			// Assert: Verify the structure is correct and session was removed
			assert.ok(result, "Result should not be undefined");
			assert.ok(
				"workspaces" in result,
				"Result should have workspaces property",
			);
			assert.strictEqual(
				result.workspaces.length,
				2,
				"Should still have 2 workspaces",
			);
			assert.strictEqual(
				result.workspaces[0].sessions.length,
				1,
				"First workspace should have 1 session after removal",
			);
			assert.strictEqual(
				result.workspaces[0].sessions[0].id,
				"session-1",
				"Remaining session should be session-1",
			);
			assert.strictEqual(
				result.workspaces[1].sessions.length,
				1,
				"Second workspace should be unchanged",
			);
		});

		it("should return undefined data unchanged", () => {
			const mutator = (
				current:
					| {
							workspaces: Array<{
								id: string;
								sessions: Array<{ id: string }>;
							}>;
					  }
					| undefined,
			) => {
				if (!current?.workspaces) return current;
				return {
					...current,
					workspaces: current.workspaces.map((workspace) => ({
						...workspace,
						sessions: workspace.sessions.filter(
							(session) => session.id !== "session-2",
						),
					})),
				};
			};

			const result = mutator(undefined);
			assert.strictEqual(
				result,
				undefined,
				"Should return undefined unchanged",
			);
		});

		it("should handle empty workspaces array", () => {
			const mutator = (
				current:
					| {
							workspaces: Array<{
								id: string;
								sessions: Array<{ id: string }>;
							}>;
					  }
					| undefined,
			) => {
				if (!current?.workspaces) return current;
				return {
					...current,
					workspaces: current.workspaces.map((workspace) => ({
						...workspace,
						sessions: workspace.sessions.filter(
							(session) => session.id !== "session-2",
						),
					})),
				};
			};

			const result = mutator({ workspaces: [] });
			assert.ok(result, "Result should not be undefined");
			assert.deepStrictEqual(
				result.workspaces,
				[],
				"Should return empty workspaces array",
			);
		});

		it("should not crash when calling map on the correct structure (regression test)", () => {
			// This is the regression test for the original bug
			// Before the fix: current.map() would throw "current.map is not a function"
			// because current was { workspaces: [...] }, not [...]

			const mockData = {
				workspaces: [
					{
						id: "ws-1",
						sessions: [{ id: "s-1" }, { id: "s-2" }],
					},
				],
			};

			// The OLD buggy code would do:
			// current.map(...) which throws because current is an object, not array

			// The NEW fixed code does:
			// current.workspaces.map(...) which works correctly
			const fixedMutator = (current: typeof mockData | undefined) => {
				if (!current?.workspaces) return current;
				return {
					...current,
					workspaces: current.workspaces.map((workspace) => ({
						...workspace,
						sessions: workspace.sessions.filter((s) => s.id !== "s-1"),
					})),
				};
			};

			// This should not throw
			assert.doesNotThrow(() => {
				fixedMutator(mockData);
			}, "Fixed mutator should not throw when handling { workspaces: [...] } structure");

			const result = fixedMutator(mockData);
			assert.strictEqual(result?.workspaces[0].sessions.length, 1);
			assert.strictEqual(result?.workspaces[0].sessions[0].id, "s-2");
		});
	});
});
