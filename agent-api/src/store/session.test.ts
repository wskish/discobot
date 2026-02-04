import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { UIMessageChunk } from "ai";
import {
	addCompletionEvent,
	clearCompletionEvents,
	finishCompletion,
	getCompletionEvents,
	getCompletionState,
	isCompletionRunning,
	startCompletion,
} from "./session.js";

describe("Completion State", () => {
	// Reset state before each test
	before(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	describe("startCompletion", () => {
		it("returns true when no completion is running", async () => {
			const result = startCompletion("test-completion-1");
			assert.equal(result, true);
			await finishCompletion(); // Cleanup
		});

		it("returns false when completion is already running", async () => {
			startCompletion("test-completion-1");
			const result = startCompletion("test-completion-2");
			assert.equal(result, false);
			await finishCompletion(); // Cleanup
		});

		it("sets isRunning to true", async () => {
			startCompletion("test-completion");
			assert.equal(isCompletionRunning(), true);
			await finishCompletion(); // Cleanup
		});

		it("stores completionId in state", async () => {
			startCompletion("my-completion-id");
			const state = getCompletionState();
			assert.equal(state.completionId, "my-completion-id");
			await finishCompletion(); // Cleanup
		});

		it("sets startedAt timestamp", async () => {
			const beforeStart = new Date().toISOString();
			startCompletion("test-completion");
			const state = getCompletionState();
			const afterStart = new Date().toISOString();

			assert.ok(state.startedAt, "Should have startedAt");
			assert.ok(
				state.startedAt >= beforeStart && state.startedAt <= afterStart,
				"startedAt should be between before and after timestamps",
			);
			await finishCompletion(); // Cleanup
		});
	});

	describe("finishCompletion", () => {
		it("sets isRunning to false", async () => {
			startCompletion("test-completion");
			await finishCompletion();
			assert.equal(isCompletionRunning(), false);
		});

		it("preserves completionId after finishing", async () => {
			startCompletion("preserved-id");
			await finishCompletion();
			const state = getCompletionState();
			assert.equal(state.completionId, "preserved-id");
		});

		it("stores error message when provided", async () => {
			startCompletion("error-completion");
			await finishCompletion("Something went wrong");
			const state = getCompletionState();
			assert.equal(state.error, "Something went wrong");
		});

		it("does not clear completion events on finish (they persist for SSE replay)", async () => {
			startCompletion("test-completion");
			const event: UIMessageChunk = { type: "start", messageId: "msg-1" };
			addCompletionEvent(event);
			assert.equal(getCompletionEvents().length, 1);

			await finishCompletion();
			// Events are NOT cleared on finish - SSE handler needs them
			// Events are cleared at start of next completion via clearCompletionEvents()
			assert.equal(getCompletionEvents().length, 1);
			clearCompletionEvents(); // Cleanup
		});
	});

	describe("isCompletionRunning", () => {
		it("returns false initially", async () => {
			await finishCompletion(); // Ensure clean state
			assert.equal(isCompletionRunning(), false);
		});

		it("returns true after start", async () => {
			startCompletion("test-completion");
			assert.equal(isCompletionRunning(), true);
			await finishCompletion(); // Cleanup
		});

		it("returns false after finish", async () => {
			startCompletion("test-completion");
			await finishCompletion();
			assert.equal(isCompletionRunning(), false);
		});
	});

	describe("getCompletionState", () => {
		it("returns a copy (not the original object)", async () => {
			startCompletion("test-completion");
			const state1 = getCompletionState();
			const state2 = getCompletionState();
			assert.notEqual(state1, state2);
			await finishCompletion(); // Cleanup
		});

		it("has correct initial state structure", async () => {
			await finishCompletion(); // Reset
			const state = getCompletionState();

			assert.equal(typeof state.isRunning, "boolean");
			assert.equal(state.error, null);
		});
	});
});

describe("Completion Events", () => {
	// Reset state before each test
	before(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	describe("addCompletionEvent", () => {
		it("adds event to the list", () => {
			clearCompletionEvents();
			const event: UIMessageChunk = { type: "start", messageId: "msg-1" };

			addCompletionEvent(event);
			const events = getCompletionEvents();

			assert.equal(events.length, 1);
			assert.deepEqual(events[0], event);
		});

		it("maintains order of events", () => {
			clearCompletionEvents();
			const event1: UIMessageChunk = { type: "start", messageId: "msg-1" };
			const event2: UIMessageChunk = {
				type: "text-start",
				id: "text-msg-1-1",
			};
			const event3: UIMessageChunk = {
				type: "text-delta",
				id: "text-msg-1-1",
				delta: "Hello",
			};

			addCompletionEvent(event1);
			addCompletionEvent(event2);
			addCompletionEvent(event3);

			const events = getCompletionEvents();
			assert.equal(events.length, 3);
			assert.deepEqual(events[0], event1);
			assert.deepEqual(events[1], event2);
			assert.deepEqual(events[2], event3);
		});
	});

	describe("getCompletionEvents", () => {
		it("returns empty array when no events", () => {
			clearCompletionEvents();
			const events = getCompletionEvents();
			assert.deepEqual(events, []);
		});

		it("returns a copy of events (not the original array)", () => {
			clearCompletionEvents();
			const event: UIMessageChunk = { type: "start", messageId: "msg-1" };
			addCompletionEvent(event);

			const events1 = getCompletionEvents();
			const events2 = getCompletionEvents();

			assert.notEqual(events1, events2);
		});

		it("modifying returned array does not affect stored events", () => {
			clearCompletionEvents();
			const event: UIMessageChunk = { type: "start", messageId: "msg-1" };
			addCompletionEvent(event);

			const events = getCompletionEvents();
			events.push({ type: "finish" }); // Modify returned array

			const freshEvents = getCompletionEvents();
			assert.equal(freshEvents.length, 1); // Original should be unchanged
		});
	});

	describe("clearCompletionEvents", () => {
		it("removes all events", () => {
			const event1: UIMessageChunk = { type: "start", messageId: "msg-1" };
			const event2: UIMessageChunk = { type: "finish" };
			addCompletionEvent(event1);
			addCompletionEvent(event2);

			clearCompletionEvents();

			assert.equal(getCompletionEvents().length, 0);
		});
	});
});

describe("Completion events workflow", () => {
	before(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	after(async () => {
		await finishCompletion();
		clearCompletionEvents();
	});

	it("simulates full completion lifecycle with events", async () => {
		// Start completion
		const started = startCompletion("lifecycle-test");
		assert.ok(started, "Should start successfully");
		assert.equal(isCompletionRunning(), true);

		// Add events during completion
		const events: UIMessageChunk[] = [
			{ type: "start", messageId: "msg-lifecycle" },
			{ type: "text-start", id: "text-msg-lifecycle-1" },
			{ type: "text-delta", id: "text-msg-lifecycle-1", delta: "Hello" },
			{ type: "text-delta", id: "text-msg-lifecycle-1", delta: " World" },
			{ type: "text-end", id: "text-msg-lifecycle-1" },
			{ type: "finish" },
		];

		for (const event of events) {
			addCompletionEvent(event);
		}

		// Verify events are stored
		const storedEvents = getCompletionEvents();
		assert.equal(storedEvents.length, 6);
		assert.deepEqual(storedEvents, events);

		// Finish completion
		await finishCompletion();

		// Verify state after finish
		assert.equal(isCompletionRunning(), false);
		// Events are NOT cleared on finish - they persist for SSE replay
		assert.equal(getCompletionEvents().length, 6);
		assert.equal(getCompletionState().error, null);
		clearCompletionEvents(); // Cleanup
	});

	it("handles completion with error", async () => {
		startCompletion("error-test");

		// Add some events before error
		addCompletionEvent({ type: "start", messageId: "msg-error" });
		addCompletionEvent({ type: "text-start", id: "text-1" });

		// Finish with error
		await finishCompletion("API rate limit exceeded");

		const state = getCompletionState();
		assert.equal(state.isRunning, false);
		assert.equal(state.error, "API rate limit exceeded");
		assert.equal(state.completionId, "error-test");
	});

	it("prevents concurrent completions", async () => {
		const first = startCompletion("first");
		const second = startCompletion("second");
		const third = startCompletion("third");

		assert.equal(first, true);
		assert.equal(second, false);
		assert.equal(third, false);

		// Only first completion should be registered
		assert.equal(getCompletionState().completionId, "first");

		await finishCompletion();
	});
});
