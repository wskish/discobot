// Default project ID for anonymous user mode (matches Go backend)
export const PROJECT_ID = "local";

export function getApiBase() {
	return `/api/projects/${PROJECT_ID}`;
}
