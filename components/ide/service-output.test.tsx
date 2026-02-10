/**
 * Unit tests for ServiceOutput component
 * Tests reconnection behavior when service status changes
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiClient from "@/lib/api-client";
import { ServiceOutput } from "./service-output";

// Track API calls
let apiCallCount = 0;
let apiCalls: Array<{ sessionId: string; serviceId: string }> = [];

// Mock EventSource type
interface MockEventSourceType {
	url: string;
	readyState: number;
	onopen: ((e: Event) => void) | null;
	onmessage: ((e: MessageEvent) => void) | null;
	onerror: ((e: Event) => void) | null;
	closed: boolean;
	close: () => void;
	addEventListener: () => void;
	removeEventListener: () => void;
}

// Helper to create mock Event
function createMockEvent(type: string): Event {
	return { type } as Event;
}

// Helper to create mock MessageEvent
function createMockMessageEvent(data: string): MessageEvent {
	return { data } as MessageEvent;
}

// Mock the getServiceOutputUrl method
// biome-ignore lint/suspicious/noExplicitAny: Need to override readonly property in test
(apiClient.api as any).getServiceOutputUrl = (
	sessionId: string,
	serviceId: string,
) => {
	apiCallCount++;
	apiCalls.push({ sessionId, serviceId });
	return `/api/sessions/${sessionId}/services/${serviceId}/output`;
};

describe("ServiceOutput", () => {
	// biome-ignore lint/suspicious/noExplicitAny: Mock class needs to be assigned to variable
	let mockEventSource: any;
	let eventSourceInstances: MockEventSourceType[] = [];

	beforeEach(() => {
		eventSourceInstances = [];

		// Mock EventSource to track instances
		mockEventSource = class MockEventSource {
			url: string;
			readyState = 0;
			onopen: ((e: Event) => void) | null = null;
			onmessage: ((e: MessageEvent) => void) | null = null;
			onerror: ((e: Event) => void) | null = null;
			closed = false;

			constructor(url: string) {
				this.url = url;
				eventSourceInstances.push(this);

				// Simulate connection opening
				setTimeout(() => {
					if (!this.closed) {
						this.readyState = 1;
						if (this.onopen) this.onopen(createMockEvent("open"));
					}
				}, 0);
			}

			close() {
				this.closed = true;
				this.readyState = 2;
			}

			addEventListener() {}
			removeEventListener() {}
		};

		// Replace global EventSource
		// biome-ignore lint/suspicious/noExplicitAny: Need to override global EventSource in test
		(globalThis as any).EventSource = mockEventSource;

		// Reset API call tracking
		apiCallCount = 0;
		apiCalls = [];
	});

	afterEach(() => {
		// Clean up all EventSource instances
		for (const instance of eventSourceInstances) {
			if (!instance.closed) {
				instance.close();
			}
		}
		eventSourceInstances = [];
	});

	describe("Initial connection", () => {
		it("creates EventSource connection on mount", async () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			assert.strictEqual(
				apiCallCount,
				1,
				"Should call getServiceOutputUrl once",
			);
			assert.deepStrictEqual(apiCalls[0], {
				sessionId: "session-123",
				serviceId: "test-service",
			});
		});

		it("displays 'No output yet' when no events received", () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			const noOutputText = screen.getByText("No output yet");
			assert.ok(noOutputText);
		});

		it("closes connection on unmount", async () => {
			const { unmount } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const firstInstance = eventSourceInstances[0];
			assert.strictEqual(firstInstance.closed, false);

			unmount();

			assert.strictEqual(firstInstance.closed, true);
		});
	});

	describe("Event handling", () => {
		it("displays stdout events", async () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const eventSource = eventSourceInstances[0];

			// Trigger onopen to set isConnected
			if (eventSource.onopen) {
				eventSource.onopen(createMockEvent("open"));
			}

			// Simulate stdout event
			const event = {
				type: "stdout",
				data: "Hello from service",
				timestamp: new Date().toISOString(),
			};

			if (eventSource.onmessage) {
				eventSource.onmessage(createMockMessageEvent(JSON.stringify(event)));
			}

			await waitFor(() => {
				const outputText = screen.getByText("Hello from service");
				assert.ok(outputText);
			});
		});

		it("displays stderr events with red styling", async () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const eventSource = eventSourceInstances[0];

			// Simulate stderr event
			const event = {
				type: "stderr",
				data: "Error message",
				timestamp: new Date().toISOString(),
			};

			if (eventSource.onmessage) {
				eventSource.onmessage(createMockMessageEvent(JSON.stringify(event)));
			}

			await waitFor(() => {
				const errorText = screen.getByText("Error message");
				assert.ok(errorText);
				assert.ok(errorText.className.includes("text-red"));
			});
		});

		it("displays exit event", async () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const eventSource = eventSourceInstances[0];

			// Simulate exit event
			const event = {
				type: "exit",
				exitCode: 0,
				timestamp: new Date().toISOString(),
			};

			if (eventSource.onmessage) {
				eventSource.onmessage(createMockMessageEvent(JSON.stringify(event)));
			}

			await waitFor(() => {
				const exitText = screen.getByText("Process exited with code 0");
				assert.ok(exitText);
			});
		});

		it("closes connection on [DONE] message", async () => {
			render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const eventSource = eventSourceInstances[0];
			assert.strictEqual(eventSource.closed, false);

			// Simulate [DONE] message
			if (eventSource.onmessage) {
				eventSource.onmessage(createMockMessageEvent("[DONE]"));
			}

			await waitFor(() => {
				assert.strictEqual(eventSource.closed, true);
			});
		});
	});

	describe("Reconnection behavior", () => {
		it("reconnects when status changes", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const firstInstance = eventSourceInstances[0];

			// Change status (simulating service restart)
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="stopped"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(
					eventSourceInstances.length,
					2,
					"Should create new EventSource",
				);
			});

			assert.strictEqual(
				firstInstance.closed,
				true,
				"First connection should be closed",
			);
			assert.strictEqual(
				eventSourceInstances[1].closed,
				false,
				"Second connection should be open",
			);
		});

		it("clears events when reconnecting", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			const firstEventSource = eventSourceInstances[0];

			// Add an event
			if (firstEventSource.onmessage) {
				firstEventSource.onmessage(
					createMockMessageEvent(
						JSON.stringify({
							type: "stdout",
							data: "Old output",
							timestamp: new Date().toISOString(),
						}),
					),
				);
			}

			await waitFor(() => {
				screen.getByText("Old output");
			});

			// Change status to trigger reconnection
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="starting"
				/>,
			);

			await waitFor(() => {
				// Old output should be gone after reconnection
				const oldOutput = screen.queryByText("Old output");
				assert.strictEqual(
					oldOutput,
					null,
					"Old events should be cleared on reconnect",
				);
			});
		});

		it("reconnects multiple times as status changes", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="stopped"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			// First restart: stopped -> starting
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="starting"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 2);
			});

			// Second restart: starting -> running
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 3);
			});

			// Third restart: running -> stopped
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="stopped"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(
					eventSourceInstances.length,
					4,
					"Should reconnect each time status changes",
				);
			});

			// Verify all previous connections are closed
			for (let i = 0; i < 3; i++) {
				assert.strictEqual(
					eventSourceInstances[i].closed,
					true,
					`Connection ${i} should be closed`,
				);
			}

			// Only the latest should be open
			assert.strictEqual(
				eventSourceInstances[3].closed,
				false,
				"Latest connection should be open",
			);
		});

		it("does not reconnect when sessionId/serviceId stay the same without status change", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
					className="custom-class"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			// Change only className (not in dependency array)
			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
					className="different-class"
				/>,
			);

			// Should not create new connection
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.strictEqual(
				eventSourceInstances.length,
				1,
				"Should not reconnect when only className changes",
			);
		});
	});

	describe("Different sessionId/serviceId", () => {
		it("reconnects when sessionId changes", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			rerender(
				<ServiceOutput
					sessionId="session-456"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 2);
			});
		});

		it("reconnects when serviceId changes", async () => {
			const { rerender } = render(
				<ServiceOutput
					sessionId="session-123"
					serviceId="test-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 1);
			});

			rerender(
				<ServiceOutput
					sessionId="session-123"
					serviceId="other-service"
					status="running"
				/>,
			);

			await waitFor(() => {
				assert.strictEqual(eventSourceInstances.length, 2);
			});
		});
	});
});
