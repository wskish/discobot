/**
 * WebSocket Proxy with proper binary handling
 *
 * Proxies WebSocket connections to local service ports.
 * Uses 'ws' library for target connections to ensure consistent binary data handling.
 */
import type { ServerWebSocket } from "bun";
import WebSocket from "ws";

const DEBUG = true;

function log(message: string, data?: Record<string, unknown>): void {
	if (!DEBUG) return;
	const timestamp = new Date().toISOString();
	if (data) {
		console.log(
			`[${timestamp}] [ws-proxy] ${message}`,
			JSON.stringify(data, null, 2),
		);
	} else {
		console.log(`[${timestamp}] [ws-proxy] ${message}`);
	}
}

/**
 * Data attached to each WebSocket connection for tracking
 */
export interface WebSocketData {
	targetUrl: string;
	serviceId: string;
	target?: WebSocket;
	/** Buffer for messages received before target is connected */
	pendingMessages?: (string | Buffer)[];
	/** Whether the target connection is ready */
	targetReady?: boolean;
}

/**
 * Create WebSocket handlers for Bun.serve
 *
 * These handlers manage the client-side WebSocket and bridge
 * messages to/from the target service WebSocket.
 *
 * Uses 'ws' library for target connections to ensure consistent
 * binary data handling between Bun's WebSocket and the target service.
 */
export function createBunWebSocketHandler() {
	return {
		/**
		 * Called when a client WebSocket connection is opened.
		 * We connect to the target service and set up bidirectional bridging.
		 */
		open(ws: ServerWebSocket<WebSocketData>) {
			const { targetUrl, serviceId } = ws.data;
			log("Client WebSocket opened", { targetUrl, serviceId });

			// Initialize pending message buffer
			ws.data.pendingMessages = [];
			ws.data.targetReady = false;

			// Use 'ws' library for target connection - better binary handling
			// Disable per-message deflate for lower latency
			const target = new WebSocket(targetUrl, {
				perMessageDeflate: false,
			});
			ws.data.target = target;

			target.on("open", () => {
				log("Target WebSocket connected", { targetUrl });
				ws.data.targetReady = true;

				// Flush any pending messages
				const pending = ws.data.pendingMessages || [];
				if (pending.length > 0) {
					log("Flushing pending messages", { count: pending.length });
					for (const msg of pending) {
						target.send(msg);
					}
					ws.data.pendingMessages = [];
				}
			});

			target.on("message", (data: Buffer, isBinary: boolean) => {
				// Forward messages from target to client
				if (ws.readyState === WebSocket.OPEN) {
					// Convert Buffer to appropriate format for Bun WebSocket
					if (isBinary) {
						// Convert Buffer to ArrayBuffer for Bun WebSocket
						// Need to slice to get actual ArrayBuffer without Node.js Buffer wrapper
						const arrayBuffer = data.buffer.slice(
							data.byteOffset,
							data.byteOffset + data.byteLength,
						);
						ws.send(arrayBuffer);
					} else {
						// Send as UTF-8 string
						ws.send(data.toString("utf8"));
					}
					log("Target -> Client", { size: data.length, binary: isBinary });
				}
			});

			target.on("close", (code: number, reason: Buffer) => {
				log("Target WebSocket closed", {
					code,
					reason: reason.toString("utf8"),
				});
				if (ws.readyState === WebSocket.OPEN) {
					ws.close(code, reason.toString("utf8"));
				}
			});

			target.on("error", (err: Error) => {
				log("Target WebSocket error", { error: err.message, stack: err.stack });
				if (ws.readyState === WebSocket.OPEN) {
					ws.close(1011, "Target error");
				}
			});
		},

		/**
		 * Called when the client sends a message.
		 * Forward to the target service, or buffer if not ready.
		 */
		message(ws: ServerWebSocket<WebSocketData>, message: string | ArrayBuffer) {
			const target = ws.data.target;

			// Convert ArrayBuffer to Buffer for 'ws' library
			// 'ws' library expects Buffer for binary data
			const msg = typeof message === "string" ? message : Buffer.from(message);

			// If target is ready, send immediately
			if (
				ws.data.targetReady &&
				target &&
				target.readyState === WebSocket.OPEN
			) {
				target.send(msg);
				log("Client -> Target", {
					size:
						typeof message === "string" ? message.length : message.byteLength,
					binary: typeof message !== "string",
				});
			} else {
				// Buffer the message until target is ready
				if (!ws.data.pendingMessages) {
					ws.data.pendingMessages = [];
				}
				ws.data.pendingMessages.push(msg);
				log("Client message buffered - target not ready", {
					bufferedCount: ws.data.pendingMessages.length,
					hasTarget: !!target,
					readyState: target?.readyState,
				});
			}
		},

		/**
		 * Called when the client WebSocket closes.
		 * Close the target connection too.
		 */
		close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
			log("Client WebSocket closed", { code, reason });
			const target = ws.data.target;
			if (target && target.readyState === WebSocket.OPEN) {
				target.close(code, reason);
			}
		},
	};
}
