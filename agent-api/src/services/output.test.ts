/**
 * Unit tests for service output storage
 */

import assert from "node:assert";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
	appendEvent,
	clearOutput,
	createErrorEvent,
	createExitEvent,
	createStderrEvent,
	createStdoutEvent,
	getOutputPath,
	readEvents,
	truncateIfNeeded,
} from "./output.js";

const TEST_OUTPUT_DIR = join(
	homedir(),
	".config",
	"discobot",
	"services",
	"output",
);
const TEST_SERVICE_ID = "test-service-output";

describe("output.ts - Service Output Storage", () => {
	// Cleanup after all tests
	after(async () => {
		try {
			await rm(getOutputPath(TEST_SERVICE_ID), { force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// Cleanup after each test
	afterEach(async () => {
		try {
			await rm(getOutputPath(TEST_SERVICE_ID), { force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("getOutputPath", () => {
		it("returns correct file path for service", () => {
			const path = getOutputPath(TEST_SERVICE_ID);
			assert.strictEqual(path, join(TEST_OUTPUT_DIR, `${TEST_SERVICE_ID}.out`));
		});
	});

	describe("clearOutput", () => {
		it("creates an empty file when file doesn't exist", async () => {
			await clearOutput(TEST_SERVICE_ID);

			const filePath = getOutputPath(TEST_SERVICE_ID);
			const content = await readFile(filePath, "utf-8");
			assert.strictEqual(content, "");
		});

		it("truncates existing file to empty", async () => {
			const filePath = getOutputPath(TEST_SERVICE_ID);
			await mkdir(TEST_OUTPUT_DIR, { recursive: true });
			await writeFile(filePath, "old content\nmore old content\n", "utf-8");

			await clearOutput(TEST_SERVICE_ID);

			const content = await readFile(filePath, "utf-8");
			assert.strictEqual(content, "");
		});

		it("ensures file is synced to disk (file size is 0)", async () => {
			const filePath = getOutputPath(TEST_SERVICE_ID);
			await mkdir(TEST_OUTPUT_DIR, { recursive: true });
			await writeFile(filePath, "old content\n", "utf-8");

			// Clear and immediately check file stats
			await clearOutput(TEST_SERVICE_ID);
			const stats = await stat(filePath);

			assert.strictEqual(stats.size, 0, "File size should be 0 after clear");
		});

		it("can be called multiple times safely", async () => {
			await clearOutput(TEST_SERVICE_ID);
			await clearOutput(TEST_SERVICE_ID);
			await clearOutput(TEST_SERVICE_ID);

			const filePath = getOutputPath(TEST_SERVICE_ID);
			const content = await readFile(filePath, "utf-8");
			assert.strictEqual(content, "");
		});
	});

	describe("appendEvent", () => {
		it("writes event as JSONL to file", async () => {
			const event = createStdoutEvent("Hello, world!");

			await appendEvent(TEST_SERVICE_ID, event);

			const filePath = getOutputPath(TEST_SERVICE_ID);
			const content = await readFile(filePath, "utf-8");
			const lines = content.trim().split("\n");

			assert.strictEqual(lines.length, 1);
			const parsed = JSON.parse(lines[0]);
			assert.strictEqual(parsed.type, "stdout");
			assert.strictEqual(parsed.data, "Hello, world!");
			assert.ok(parsed.timestamp);
		});

		it("appends multiple events", async () => {
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("Line 1"));
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("Line 2"));
			await appendEvent(TEST_SERVICE_ID, createStderrEvent("Error 1"));

			const events = await readEvents(TEST_SERVICE_ID);
			assert.strictEqual(events.length, 3);
			assert.strictEqual(events[0].data, "Line 1");
			assert.strictEqual(events[1].data, "Line 2");
			assert.strictEqual(events[2].data, "Error 1");
		});
	});

	describe("readEvents", () => {
		it("returns empty array when file doesn't exist", async () => {
			const events = await readEvents(TEST_SERVICE_ID);
			assert.deepStrictEqual(events, []);
		});

		it("returns empty array when file is empty", async () => {
			await clearOutput(TEST_SERVICE_ID);

			const events = await readEvents(TEST_SERVICE_ID);
			assert.deepStrictEqual(events, []);
		});

		it("parses all events from file", async () => {
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("stdout data"));
			await appendEvent(TEST_SERVICE_ID, createStderrEvent("stderr data"));
			await appendEvent(TEST_SERVICE_ID, createExitEvent(0));

			const events = await readEvents(TEST_SERVICE_ID);
			assert.strictEqual(events.length, 3);
			assert.strictEqual(events[0].type, "stdout");
			assert.strictEqual(events[1].type, "stderr");
			assert.strictEqual(events[2].type, "exit");
			assert.strictEqual(events[2].exitCode, 0);
		});
	});

	describe("clearOutput followed by appendEvent (race condition test)", () => {
		it("ensures clear is synced before new events are appended", async () => {
			// Write old events
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("old event 1"));
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("old event 2"));

			// Clear should flush to disk
			await clearOutput(TEST_SERVICE_ID);

			// Immediately append new events
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("new event 1"));
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("new event 2"));

			// Read events - should only see new events
			const events = await readEvents(TEST_SERVICE_ID);
			assert.strictEqual(
				events.length,
				2,
				"Should only have 2 new events, old events should be gone",
			);
			assert.strictEqual(events[0].data, "new event 1");
			assert.strictEqual(events[1].data, "new event 2");
		});

		it("file size is exactly 0 bytes after clear, before append", async () => {
			// Write some content
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("old content"));

			// Clear
			await clearOutput(TEST_SERVICE_ID);

			// Check file size immediately
			const filePath = getOutputPath(TEST_SERVICE_ID);
			const stats = await stat(filePath);
			assert.strictEqual(
				stats.size,
				0,
				"File should be exactly 0 bytes after clear",
			);
		});
	});

	describe("truncateIfNeeded", () => {
		it("does nothing when file is small", async () => {
			await appendEvent(TEST_SERVICE_ID, createStdoutEvent("small data"));

			await truncateIfNeeded(TEST_SERVICE_ID);

			const events = await readEvents(TEST_SERVICE_ID);
			assert.strictEqual(events.length, 1);
		});

		it("truncates file when it exceeds 1MB", async () => {
			// Write > 1MB of data
			const largeData = "x".repeat(100000); // 100KB per event
			for (let i = 0; i < 15; i++) {
				// 15 * 100KB = 1.5MB
				await appendEvent(
					TEST_SERVICE_ID,
					createStdoutEvent(`${i}: ${largeData}`),
				);
			}

			const filePath = getOutputPath(TEST_SERVICE_ID);
			const beforeStats = await stat(filePath);
			assert.ok(beforeStats.size > 1024 * 1024, "File should be > 1MB");

			await truncateIfNeeded(TEST_SERVICE_ID);

			const afterStats = await stat(filePath);
			assert.ok(
				afterStats.size < beforeStats.size,
				"File should be smaller after truncate",
			);

			// Should keep roughly half the events
			const events = await readEvents(TEST_SERVICE_ID);
			assert.ok(events.length > 0, "Should still have some events");
			assert.ok(events.length < 15, "Should have fewer than all events");
		});
	});

	describe("event creation helpers", () => {
		it("createStdoutEvent", () => {
			const event = createStdoutEvent("test data");
			assert.strictEqual(event.type, "stdout");
			assert.strictEqual(event.data, "test data");
			assert.ok(event.timestamp);
		});

		it("createStderrEvent", () => {
			const event = createStderrEvent("error data");
			assert.strictEqual(event.type, "stderr");
			assert.strictEqual(event.data, "error data");
			assert.ok(event.timestamp);
		});

		it("createExitEvent with exit code", () => {
			const event = createExitEvent(0);
			assert.strictEqual(event.type, "exit");
			assert.strictEqual(event.exitCode, 0);
			assert.ok(event.timestamp);
		});

		it("createExitEvent with null exit code", () => {
			const event = createExitEvent(null);
			assert.strictEqual(event.type, "exit");
			assert.strictEqual(event.exitCode, undefined);
			assert.ok(event.timestamp);
		});

		it("createErrorEvent", () => {
			const event = createErrorEvent("something went wrong");
			assert.strictEqual(event.type, "error");
			assert.strictEqual(event.error, "something went wrong");
			assert.ok(event.timestamp);
		});
	});
});
