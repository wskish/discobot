// Default project ID for anonymous user mode (matches Go backend)
export const PROJECT_ID = "local";

/**
 * Get the backend API root URL (without project path).
 *
 * - In Tauri: uses relative URLs (Tauri handles routing)
 * - In browser with *-svc-ui.* hostname: routes to corresponding *-svc-api.* host
 * - Otherwise: calls Go backend directly on port 3001
 */
export function getApiRootBase() {
	if (typeof window === "undefined") {
		// Server-side rendering - call backend directly
		return "http://localhost:3001/api";
	}

	// Check if running in Tauri
	const isTauri = "__TAURI__" in window;
	if (isTauri) {
		// Tauri handles routing to the backend
		return "/api";
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
 *
 * - In Tauri: uses relative URLs (Tauri handles routing)
 * - In browser with *-svc-ui.* hostname: routes to corresponding *-svc-api.* host
 * - Otherwise: calls Go backend directly on port 3001
 */
export function getApiBase() {
	return `${getApiRootBase()}/projects/${PROJECT_ID}`;
}

/**
 * Get the backend WebSocket base URL.
 *
 * - In Tauri: uses current host with ws:// or wss:// protocol
 * - In browser with *-svc-ui.* hostname: routes to corresponding *-svc-api.* host
 * - Otherwise: connects to Go backend directly on port 3001
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

	// Connect to Go backend directly on port 3001
	return `ws://localhost:3001/api/projects/${PROJECT_ID}`;
}
