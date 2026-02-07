import type { ServerWebSocket } from "bun";
import { createApp } from "./server/app.js";
import {
	createBunWebSocketHandler,
	type WebSocketData,
} from "./services/websocket-proxy.js";

// Load configuration from environment variables
const agentCwd = process.env.AGENT_CWD || process.cwd();
const port = Number(process.env.PORT) || 3002;
const sharedSecretHash = process.env.DISCOBOT_SECRET;
if (process.env.DISCOBOT_SECRET) {
	delete process.env.DISCOBOT_SECRET;
}

const { app, getServicePort } = createApp({
	agentCwd,
	enableLogging: true,
	sharedSecretHash,
});

// Use Bun's native serve if available, otherwise fall back to Node
declare const Bun:
	| {
			serve: (options: {
				fetch: (
					req: Request,
					server: { upgrade: (req: Request, options?: object) => boolean },
				) => Response | Promise<Response>;
				port: number;
				/** Disable idle timeout (0 = no timeout) */
				idleTimeout?: number;
				websocket: {
					open: (ws: ServerWebSocket<WebSocketData>) => void;
					message: (
						ws: ServerWebSocket<WebSocketData>,
						message: string | ArrayBuffer,
					) => void;
					close: (
						ws: ServerWebSocket<WebSocketData>,
						code: number,
						reason: string,
					) => void;
					/** Disable idle timeout for WebSocket connections */
					idleTimeout?: number;
				};
			}) => void;
	  }
	| undefined;

// Pattern to match service HTTP proxy routes: /services/:id/http/*
const SERVICE_HTTP_PATTERN = /^\/services\/([^/]+)\/http(\/.*)?$/;

async function startServer() {
	if (typeof Bun !== "undefined") {
		const wsHandler = createBunWebSocketHandler();

		Bun.serve({
			fetch: async (req, server) => {
				// Check if this is a WebSocket upgrade request for a service
				const upgradeHeader = req.headers.get("upgrade")?.toLowerCase();
				if (upgradeHeader === "websocket") {
					const url = new URL(req.url);
					const match = url.pathname.match(SERVICE_HTTP_PATTERN);

					if (match) {
						const serviceId = match[1];
						const forwardedPath =
							req.headers.get("x-forwarded-path") || match[2] || "/";

						// Get the service port
						const port = await getServicePort(serviceId);
						if (!port) {
							return new Response(
								JSON.stringify({
									error: "service_not_available",
									message: "Service not found or not running",
								}),
								{
									status: 502,
									headers: { "content-type": "application/json" },
								},
							);
						}

						// Build target WebSocket URL
						const targetUrl = `ws://localhost:${port}${forwardedPath}${url.search}`;

						console.log(
							`[ws-proxy] Upgrading WebSocket: ${url.pathname} -> ${targetUrl}`,
						);

						// Upgrade the connection
						const upgraded = server.upgrade(req, {
							data: { targetUrl, serviceId } satisfies WebSocketData,
						});

						if (upgraded) {
							// Return undefined to signal successful upgrade
							return undefined as unknown as Response;
						}

						return new Response("WebSocket upgrade failed", { status: 500 });
					}
				}

				// Fall through to Hono for regular HTTP requests
				return app.fetch(req);
			},
			port: port,
			// Disable idle timeout for HTTP connections (0 = no timeout)
			// This is important for long-running SSE streams and proxied connections
			idleTimeout: 0,
			websocket: {
				...wsHandler,
				// Disable idle timeout for WebSocket connections
				idleTimeout: 0,
			},
		});
	} else {
		// Node.js fallback - no WebSocket support for now
		const { serve } = await import("@hono/node-server");
		const server = serve(
			{
				fetch: app.fetch,
				port: port,
				serverOptions: {
					// Disable request timeout (important for SSE and long-running connections)
					requestTimeout: 0,
					// Disable keep-alive timeout
					keepAliveTimeout: 0,
					// Disable headers timeout
					headersTimeout: 0,
				},
			},
			() => {
				console.log(
					"[warn] Running in Node.js mode - WebSocket proxy not supported",
				);
			},
		);
		// Also disable timeout on the server itself (cast to access timeout property)
		(server as { timeout?: number }).timeout = 0;
	}
}

async function main() {
	console.log(`Starting agent service on port ${port}`);
	console.log(`Agent cwd: ${agentCwd}`);
	console.log(
		`Auth enforcement: ${sharedSecretHash ? "enabled" : "disabled"}`,
	);

	// Start the HTTP server
	await startServer();
	console.log(`Agent server listening on port ${port}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
