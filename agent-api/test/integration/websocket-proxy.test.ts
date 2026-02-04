/**
 * WebSocket Proxy Integration Tests
 *
 * Tests the WebSocket proxy functionality to ensure proper message
 * forwarding for both text and binary data.
 *
 * Note: These tests use the 'ws' library to create test servers
 * that work in both Node and Bun environments.
 */

import assert from "node:assert";
import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

// Constants
const ECHO_SERVER_PORT = 8765;
const PROXY_SERVER_PORT = 8766;
const TEST_TIMEOUT = 10000; // 10 seconds

interface TestContext {
	echoServer?: WebSocketServer;
	echoHttpServer?: HttpServer;
	proxyServer?: WebSocketServer;
	proxyHttpServer?: HttpServer;
}

const context: TestContext = {};

/**
 * Create a simple echo WebSocket server for testing
 */
function createEchoServer(port: number): Promise<{
	wsServer: WebSocketServer;
	httpServer: HttpServer;
}> {
	return new Promise((resolve, reject) => {
		const httpServer = createServer();
		const wsServer = new WebSocketServer({ server: httpServer });

		wsServer.on("connection", (ws) => {
			console.log(`[echo:${port}] Client connected`);

			ws.on("message", (data, isBinary) => {
				// Echo back the message immediately
				ws.send(data, { binary: isBinary });
			});

			ws.on("close", (code, reason) => {
				console.log(`[echo:${port}] Client disconnected`, {
					code,
					reason: reason.toString(),
				});
			});
		});

		httpServer.listen(port, () => {
			console.log(`Echo server started on port ${port}`);
			resolve({ wsServer, httpServer });
		});

		httpServer.on("error", reject);
	});
}

/**
 * Create a proxy server that forwards to the echo server
 * This simulates what the actual Bun-based proxy does
 */
function createProxyServer(
	port: number,
	targetPort: number,
): Promise<{ wsServer: WebSocketServer; httpServer: HttpServer }> {
	return new Promise((resolve, reject) => {
		const httpServer = createServer();
		const wsServer = new WebSocketServer({ server: httpServer });

		wsServer.on("connection", (clientWs) => {
			console.log(`[proxy:${port}] Client connected`);

			const targetUrl = `ws://localhost:${targetPort}`;
			const targetWs = new WebSocket(targetUrl);
			const pendingMessages: { data: Buffer; binary: boolean }[] = [];
			let targetReady = false;

			// When target connects, flush pending messages
			targetWs.on("open", () => {
				console.log(`[proxy:${port}] Target connected: ${targetUrl}`);
				targetReady = true;

				// Flush pending messages
				if (pendingMessages.length > 0) {
					console.log(
						`[proxy:${port}] Flushing ${pendingMessages.length} pending messages`,
					);
					for (const msg of pendingMessages) {
						targetWs.send(msg.data, { binary: msg.binary });
					}
					pendingMessages.length = 0;
				}
			});

			// Forward messages from target to client
			targetWs.on("message", (data: Buffer, isBinary: boolean) => {
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.send(data, { binary: isBinary });
					console.log(
						`[proxy:${port}] Target -> Client: ${data.length} bytes, binary: ${isBinary}`,
					);
				}
			});

			// Forward messages from client to target
			clientWs.on("message", (data: Buffer, isBinary: boolean) => {
				if (targetReady && targetWs.readyState === WebSocket.OPEN) {
					targetWs.send(data, { binary: isBinary });
					console.log(
						`[proxy:${port}] Client -> Target: ${data.length} bytes, binary: ${isBinary}`,
					);
				} else {
					// Buffer until target is ready
					pendingMessages.push({ data, binary: isBinary });
					console.log(
						`[proxy:${port}] Buffered message (${pendingMessages.length} pending)`,
					);
				}
			});

			// Handle close events
			targetWs.on("close", (code, reason) => {
				console.log(`[proxy:${port}] Target closed`, {
					code,
					reason: reason.toString(),
				});
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.close(code, reason.toString());
				}
			});

			clientWs.on("close", (code, reason) => {
				console.log(`[proxy:${port}] Client closed`, {
					code,
					reason: reason.toString(),
				});
				if (targetWs.readyState === WebSocket.OPEN) {
					targetWs.close(code, reason.toString());
				}
			});

			// Handle errors
			targetWs.on("error", (err) => {
				console.error(`[proxy:${port}] Target error:`, err.message);
				if (clientWs.readyState === WebSocket.OPEN) {
					clientWs.close(1011, "Target error");
				}
			});

			clientWs.on("error", (err) => {
				console.error(`[proxy:${port}] Client error:`, err.message);
			});
		});

		httpServer.listen(port, () => {
			console.log(`Proxy server started on port ${port} -> ${targetPort}`);
			resolve({ wsServer, httpServer });
		});

		httpServer.on("error", reject);
	});
}

/**
 * Wait for a WebSocket to be open
 */
function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

/**
 * Wait for a specific message on a WebSocket
 */
function waitForMessage(
	ws: WebSocket,
	timeout = 5000,
): Promise<{ data: Buffer; isBinary: boolean }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("Timeout waiting for message"));
		}, timeout);

		ws.once("message", (data: Buffer, isBinary: boolean) => {
			clearTimeout(timer);
			resolve({ data, isBinary });
		});

		ws.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Close a server gracefully
 */
function closeServer(
	wsServer: WebSocketServer,
	httpServer: HttpServer,
): Promise<void> {
	return new Promise((resolve) => {
		// Close all WebSocket connections
		for (const client of wsServer.clients) {
			client.close(1000, "Server shutdown");
		}

		// Close the WebSocket server
		wsServer.close(() => {
			// Close the HTTP server
			httpServer.close(() => {
				resolve();
			});
		});
	});
}

describe("WebSocket Proxy", () => {
	beforeEach(async () => {
		// Start echo server
		const echo = await createEchoServer(ECHO_SERVER_PORT);
		context.echoServer = echo.wsServer;
		context.echoHttpServer = echo.httpServer;

		// Start proxy server
		const proxy = await createProxyServer(PROXY_SERVER_PORT, ECHO_SERVER_PORT);
		context.proxyServer = proxy.wsServer;
		context.proxyHttpServer = proxy.httpServer;

		// Wait a bit for servers to be ready
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	afterEach(async () => {
		// Stop servers
		if (context.proxyServer && context.proxyHttpServer) {
			await closeServer(context.proxyServer, context.proxyHttpServer);
			console.log("Proxy server stopped");
		}
		if (context.echoServer && context.echoHttpServer) {
			await closeServer(context.echoServer, context.echoHttpServer);
			console.log("Echo server stopped");
		}

		// Wait a bit for cleanup
		await new Promise((resolve) => setTimeout(resolve, 100));
	});

	test("should proxy text messages", { timeout: TEST_TIMEOUT }, async () => {
		const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
		await waitForOpen(ws);

		const testMessage = JSON.stringify({
			type: "test",
			content: "Hello, WebSocket!",
			timestamp: Date.now(),
		});

		// Send text message
		ws.send(testMessage);

		// Wait for echo
		const response = await waitForMessage(ws);
		const responseText = response.data.toString("utf8");

		assert.strictEqual(
			responseText,
			testMessage,
			"Echoed text message should match sent message",
		);
		assert.strictEqual(
			response.isBinary,
			false,
			"Response should be marked as text",
		);

		ws.close(1000, "Test complete");
	});

	test(
		"should proxy binary messages (ArrayBuffer)",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			// Create a binary message (ArrayBuffer)
			const buffer = new ArrayBuffer(8);
			const view = new DataView(buffer);
			view.setUint32(0, 0x12345678, false); // Big-endian
			view.setUint32(4, 0x9abcdef0, false);

			// Send binary message
			ws.send(buffer);

			// Wait for echo
			const response = await waitForMessage(ws);
			assert.ok(Buffer.isBuffer(response.data), "Response should be a Buffer");
			assert.strictEqual(
				response.isBinary,
				true,
				"Response should be marked as binary",
			);

			// Convert to DataView for comparison
			const responseView = new DataView(
				response.data.buffer,
				response.data.byteOffset,
				response.data.byteLength,
			);

			assert.strictEqual(
				responseView.getUint32(0, false),
				0x12345678,
				"First 4 bytes should match",
			);
			assert.strictEqual(
				responseView.getUint32(4, false),
				0x9abcdef0,
				"Last 4 bytes should match",
			);

			ws.close(1000, "Test complete");
		},
	);

	test(
		"should proxy binary messages (Uint8Array)",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			// Create a Uint8Array
			const data = new Uint8Array([0, 1, 2, 3, 4, 5, 255, 254, 253]);

			// Send binary message
			ws.send(data);

			// Wait for echo
			const response = await waitForMessage(ws);
			assert.ok(Buffer.isBuffer(response.data), "Response should be a Buffer");
			assert.strictEqual(
				response.isBinary,
				true,
				"Response should be marked as binary",
			);

			// Compare byte by byte
			assert.strictEqual(
				response.data.length,
				data.length,
				"Response length should match",
			);
			for (let i = 0; i < data.length; i++) {
				assert.strictEqual(
					response.data[i],
					data[i],
					`Byte at index ${i} should match`,
				);
			}

			ws.close(1000, "Test complete");
		},
	);

	test(
		"should handle multiple messages in sequence",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			// Send text message
			const textMsg = "First message";
			ws.send(textMsg);
			const response1 = await waitForMessage(ws);
			assert.strictEqual(
				response1.data.toString("utf8"),
				textMsg,
				"First message should echo correctly",
			);
			assert.strictEqual(response1.isBinary, false, "Should be text");

			// Send binary message
			const binaryMsg = new Uint8Array([10, 20, 30, 40]);
			ws.send(binaryMsg);
			const response2 = await waitForMessage(ws);
			assert.deepStrictEqual(
				new Uint8Array(response2.data),
				binaryMsg,
				"Second message should echo correctly",
			);
			assert.strictEqual(response2.isBinary, true, "Should be binary");

			// Send another text message
			const textMsg2 = "Third message";
			ws.send(textMsg2);
			const response3 = await waitForMessage(ws);
			assert.strictEqual(
				response3.data.toString("utf8"),
				textMsg2,
				"Third message should echo correctly",
			);
			assert.strictEqual(response3.isBinary, false, "Should be text");

			ws.close(1000, "Test complete");
		},
	);

	test(
		"should handle rapid message sending",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			const messageCount = 100;
			const messages: string[] = [];
			const responses: string[] = [];

			// Set up message listener
			const messagePromise = new Promise<void>((resolve, reject) => {
				let receivedCount = 0;
				const timeout = setTimeout(() => {
					reject(
						new Error(
							`Only received ${receivedCount}/${messageCount} messages`,
						),
					);
				}, 5000);

				ws.on("message", (data: Buffer) => {
					responses.push(data.toString("utf8"));
					receivedCount++;
					if (receivedCount === messageCount) {
						clearTimeout(timeout);
						resolve();
					}
				});
			});

			// Send many messages rapidly
			for (let i = 0; i < messageCount; i++) {
				const msg = `Message ${i}`;
				messages.push(msg);
				ws.send(msg);
			}

			// Wait for all responses
			await messagePromise;

			// Verify all messages were echoed (order may not be guaranteed)
			assert.strictEqual(
				responses.length,
				messageCount,
				"Should receive all messages",
			);

			// Sort both arrays and compare
			messages.sort();
			responses.sort();
			assert.deepStrictEqual(
				responses,
				messages,
				"All messages should be echoed",
			);

			ws.close(1000, "Test complete");
		},
	);

	test(
		"should handle connection close properly",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			// Send a message
			ws.send("test");
			await waitForMessage(ws);

			// Close connection
			const closePromise = new Promise<void>((resolve) => {
				ws.once("close", (code, _reason) => {
					assert.strictEqual(code, 1000, "Close code should be 1000");
					resolve();
				});
			});

			ws.close(1000, "Normal closure");
			await closePromise;
		},
	);

	test(
		"should handle large binary messages",
		{ timeout: TEST_TIMEOUT },
		async () => {
			const ws = new WebSocket(`ws://localhost:${PROXY_SERVER_PORT}`);
			await waitForOpen(ws);

			// Create a large binary message (1MB)
			const size = 1024 * 1024;
			const largeData = new Uint8Array(size);
			for (let i = 0; i < size; i++) {
				largeData[i] = i % 256;
			}

			// Send large binary message
			ws.send(largeData);

			// Wait for echo
			const response = await waitForMessage(ws, 10000); // Longer timeout for large message
			assert.ok(Buffer.isBuffer(response.data), "Response should be a Buffer");
			assert.strictEqual(
				response.isBinary,
				true,
				"Response should be marked as binary",
			);
			assert.strictEqual(
				response.data.length,
				size,
				"Response length should match",
			);

			// Verify first and last few bytes
			assert.strictEqual(response.data[0], 0, "First byte should match");
			assert.strictEqual(response.data[100], 100, "Byte 100 should match");
			assert.strictEqual(
				response.data[size - 1],
				(size - 1) % 256,
				"Last byte should match",
			);

			ws.close(1000, "Test complete");
		},
	);

	test(
		"should connect directly to echo server (control test)",
		{ timeout: TEST_TIMEOUT },
		async () => {
			// This test connects directly to the echo server to verify it works
			const ws = new WebSocket(`ws://localhost:${ECHO_SERVER_PORT}`);
			await waitForOpen(ws);

			const testMessage = "Direct connection test";
			ws.send(testMessage);

			const response = await waitForMessage(ws);
			assert.strictEqual(
				response.data.toString("utf8"),
				testMessage,
				"Direct echo should work",
			);
			assert.strictEqual(response.isBinary, false, "Should be marked as text");

			ws.close(1000, "Test complete");
		},
	);
});
