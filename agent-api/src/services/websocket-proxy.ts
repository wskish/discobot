/**
 * WebSocket Proxy with header forwarding
 *
 * Proxies WebSocket connections to local service ports.
 * Uses Bun's ServerWebSocket for client connections and 'ws' library
 * for target connections (to support forwarding headers on upgrade).
 */
import type { ServerWebSocket } from "bun";
import WebSocket from "ws";

const DEBUG = false;

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
 * Headers to strip from the upgrade request before forwarding to the target.
 * These are hop-by-hop or WebSocket handshake headers that must not be proxied.
 */
const EXCLUDED_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
	// WebSocket handshake headers - negotiated independently with each hop
	"sec-websocket-key",
	"sec-websocket-version",
	"sec-websocket-extensions",
	"sec-websocket-accept",
]);

/**
 * Build headers to forward from the client upgrade request to the target.
 * Strips hop-by-hop and WebSocket handshake headers, preserves everything
 * else (cookies, auth, x-forwarded-*, etc.).
 */
export function buildTargetHeaders(
	clientHeaders: Headers,
	targetPort: number,
): Record<string, string> {
	const headers: Record<string, string> = {};

	for (const [key, value] of clientHeaders.entries()) {
		if (!EXCLUDED_HEADERS.has(key.toLowerCase())) {
			headers[key] = value;
		}
	}

	// Set host to the target
	headers.host = `localhost:${targetPort}`;

	return headers;
}

/**
 * Data attached to each WebSocket connection for tracking
 */
export interface WebSocketData {
	targetUrl: string;
	serviceId: string;
	/** Headers to forward to the target service */
	headers?: Record<string, string>;
	target?: WebSocket;
	/** Buffer for messages received before target is connected */
	pendingMessages?: (string | Buffer)[];
	/** Whether the target connection is ready */
	targetReady?: boolean;
}

/**
 * Create WebSocket handlers for Bun.serve
 *
 * These handlers manage the client-side WebSocket (Bun ServerWebSocket)
 * and bridge messages to/from the target service WebSocket ('ws' library,
 * which supports custom headers on the upgrade request).
 */
export function createBunWebSocketHandler() {
	return {
		/**
		 * Called when a client WebSocket connection is opened.
		 * We connect to the target service and set up bidirectional bridging.
		 */
		open(ws: ServerWebSocket<WebSocketData>) {
			const { targetUrl, serviceId, headers } = ws.data;
			log("Client WebSocket opened", { targetUrl, serviceId });

			// Initialize pending message buffer
			ws.data.pendingMessages = [];
			ws.data.targetReady = false;

			// Use 'ws' library for target connection to forward headers
			const target = new WebSocket(targetUrl, {
				perMessageDeflate: false,
				headers,
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
					if (isBinary) {
						// Convert Buffer to ArrayBuffer for Bun ServerWebSocket
						const arrayBuffer = data.buffer.slice(
							data.byteOffset,
							data.byteOffset + data.byteLength,
						);
						ws.send(arrayBuffer);
					} else {
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
				log("Target WebSocket error", {
					error: err.message,
					stack: err.stack,
				});
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
