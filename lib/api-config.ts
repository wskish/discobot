// Default project ID for anonymous user mode (matches Go backend)
export const PROJECT_ID = "local";

// Cookie name for Tauri auth
const AUTH_COOKIE_NAME = "discobot_secret";

// Cached Tauri server config (populated on first use)
let tauriServerConfig: { port: number; secret: string } | null = null;

/**
 * Initialize Tauri server config (port and secret).
 * Call this early in app startup when running in Tauri.
 * Sets the auth cookie so all subsequent requests are authenticated.
 */
export async function initTauriConfig(): Promise<void> {
	if (typeof window === "undefined" || !("__TAURI__" in window)) {
		return;
	}

	const { invoke } = await import("@tauri-apps/api/core");
	const [port, secret] = await Promise.all([
		invoke<number>("get_server_port"),
		invoke<string>("get_server_secret"),
	]);
	tauriServerConfig = { port, secret };

	console.log(`Initialized Tauri server config with port ${port} and secret`);
	// Set the auth cookie - it will be sent with all requests to the Go server
	// SameSite=Strict for security, no expiry (session cookie)
	// biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API has limited browser support
	document.cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(secret)}; path=/; SameSite=Strict`;
}

/**
 * Get cached Tauri server config. Returns null if not in Tauri or not initialized.
 */
export function getTauriServerConfig() {
	return tauriServerConfig;
}

/**
 * Check if running in Tauri with initialized config.
 */
export function isTauriMode(): boolean {
	return tauriServerConfig !== null;
}

/**
 * Get the backend API root URL (without project path).
 *
 * - In Tauri: connects directly to Go server on dynamic port
 * - In browser with *-svc-ui.* hostname: routes to corresponding *-svc-api.* host
 * - Otherwise: calls Go backend directly on port 3001
 */
export function getApiRootBase() {
	if (typeof window === "undefined") {
		// Server-side rendering - call backend directly
		return "http://localhost:3001/api";
	}

	// Check if running in Tauri with initialized config
	if (tauriServerConfig) {
		return `http://127.0.0.1:${tauriServerConfig.port}/api`;
	}

	// Check if hostname matches *-svc-ui.* pattern
	const hostname = window.location.hostname;
	if (hostname.includes("-svc-ui.")) {
		const apiHostname = hostname.replace("-svc-ui.", "-svc-api.");
		const protocol = window.location.protocol;
		const port = window.location.port;
		const apiHost = port ? `${apiHostname}:${port}` : apiHostname;
		return `${protocol}//${apiHost}/api`;
	}

	// Call Go backend directly on port 3001
	return "http://localhost:3001/api";
}

/**
 * Get the backend API base URL (with project path).
 */
export function getApiBase() {
	return `${getApiRootBase()}/projects/${PROJECT_ID}`;
}

/**
 * Get the backend WebSocket base URL.
 *
 * - In Tauri: connects directly to Go server on dynamic port
 * - In browser with *-svc-ui.* hostname: routes to corresponding *-svc-api.* host
 * - Otherwise: connects to Go backend directly on port 3001
 */
export function getWsBase() {
	if (typeof window === "undefined") {
		return "";
	}

	// Check if running in Tauri with initialized config
	if (tauriServerConfig) {
		return `ws://127.0.0.1:${tauriServerConfig.port}/api/projects/${PROJECT_ID}`;
	}

	// Check if hostname matches *-svc-ui.* pattern
	const hostname = window.location.hostname;
	if (hostname.includes("-svc-ui.")) {
		const apiHostname = hostname.replace("-svc-ui.", "-svc-api.");
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const port = window.location.port;
		const apiHost = port ? `${apiHostname}:${port}` : apiHostname;
		return `${protocol}//${apiHost}/api/projects/${PROJECT_ID}`;
	}

	// Connect to Go backend directly on port 3001
	return `ws://localhost:3001/api/projects/${PROJECT_ID}`;
}
