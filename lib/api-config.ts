// Default project ID for anonymous user mode (matches Go backend)
export const PROJECT_ID = "local";

/**
 * Get the backend API base URL.
 *
 * Always uses relative URLs - Next.js proxies to the Go backend via rewrites.
 */
export function getApiBase() {
	if (typeof window === "undefined") {
		// Server-side rendering - use relative URL
		return `/api/projects/${PROJECT_ID}`;
	}

	// Check if running in Tauri
	const isTauri = "__TAURI__" in window;
	if (isTauri) {
		// Tauri handles routing to the backend
		return `/api/projects/${PROJECT_ID}`;
	}

	// Check if hostname matches *-svc-ui.* pattern
	const hostname = window.location.hostname;
	if (hostname.includes("-svc-ui.")) {
		const apiHostname = hostname.replace("-svc-ui.", "-svc-api.");
		const protocol = window.location.protocol;
		const port = window.location.port;
		const apiHost = port ? `${apiHostname}:${port}` : apiHostname;
		return `${protocol}//${apiHost}/api/projects/${PROJECT_ID}`;
	}

	// Use relative URLs - Next.js proxies to the Go backend via rewrites
	return `/api/projects/${PROJECT_ID}`;
}

/**
 * Get the backend WebSocket base URL.
 *
 * Uses current host with ws:// or wss:// protocol.
 */
export function getWsBase() {
	if (typeof window === "undefined") {
		// Server-side rendering - shouldn't be used, but return empty
		return "";
	}

	// Check if running in Tauri
	const isTauri = "__TAURI__" in window;
	if (isTauri) {
		// Tauri handles routing - use current host with proper protocol
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${window.location.host}/api/projects/${PROJECT_ID}`;
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

	// Default: use current host with proper protocol
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}/api/projects/${PROJECT_ID}`;
}
