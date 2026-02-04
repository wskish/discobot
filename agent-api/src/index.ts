import { hasMetadata, loadConfig, METADATA_PATH } from "./config/metadata.js";
import { isSocatAvailable, startVsockForwarder } from "./config/vsock.js";
import { createApp } from "./server/app.js";
import {
	createBunWebSocketHandler,
	type WebSocketData,
} from "./services/websocket-proxy.js";

// Load configuration from VirtioFS metadata or environment variables
const config = loadConfig();

const { app, getServicePort } = createApp({
	agentCwd: config.agentCwd,
	enableLogging: true,
	sharedSecretHash: config.sharedSecretHash,
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
					open: (ws: WebSocket & { data: WebSocketData }) => void;
					message: (
						ws: WebSocket & { data: WebSocketData },
						message: string | ArrayBuffer,
					) => void;
					close: (
						ws: WebSocket & { data: WebSocketData },
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
			port: config.port,
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
				port: config.port,
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
	console.log(`Starting agent service on port ${config.port}`);
	console.log(`Agent cwd: ${config.agentCwd}`);
	console.log(
		`Auth enforcement: ${config.sharedSecretHash ? "enabled" : "disabled"}`,
	);

	if (hasMetadata()) {
		console.log(`VirtioFS metadata: ${METADATA_PATH}`);
		if (config.sessionId) {
			console.log(`Session ID: ${config.sessionId}`);
		}
	}

	// Start vsock forwarder if configured
	if (config.vsock) {
		const hasSocat = await isSocatAvailable();
		if (!hasSocat) {
			console.error(
				"ERROR: vsock forwarding configured but socat is not installed",
			);
			console.error("Install socat or remove vsock configuration");
			process.exit(1);
		}

		try {
			await startVsockForwarder(config.vsock, config.port);
			console.log(
				`Vsock forwarding: vsock:${config.vsock.port} → tcp:${config.port}`,
			);
		} catch (err) {
			console.error("Failed to start vsock forwarder:", err);
			process.exit(1);
		}
	}

	// Start the HTTP server
	await startServer();
	console.log(`Agent server listening on port ${config.port}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
