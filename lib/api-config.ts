export const PROJECT_ID = "local";

export function getApiBase() {
	return `/api/projects/${PROJECT_ID}`;
}
