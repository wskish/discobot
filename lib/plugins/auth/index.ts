/**
 * Auth Plugin Registry
 *
 * Central registry for all authentication plugins.
 * Plugins are loaded and registered here, making them available
 * to the credentials dialog and other components.
 */

// Import all auth plugins
import { anthropicAuthPlugin } from "./anthropic";
import { codexAuthPlugin } from "./codex";
import { githubCopilotAuthPlugin } from "./github-copilot";
import type { AuthPlugin, AuthTypeOption } from "./types";

// Re-export plugin components
export { AnthropicOAuthFlow } from "./anthropic";
export { CodexOAuthFlow } from "./codex";
export { GitHubCopilotOAuthFlow } from "./github-copilot";
// Re-export types
export type { AuthPlugin, AuthTypeOption, OAuthOption } from "./types";

/**
 * Registry of all available auth plugins, keyed by provider ID
 */
const authPlugins: Record<string, AuthPlugin> = {
	[anthropicAuthPlugin.providerId]: anthropicAuthPlugin,
	[codexAuthPlugin.providerId]: codexAuthPlugin,
	[githubCopilotAuthPlugin.providerId]: githubCopilotAuthPlugin,
};

/**
 * Get an auth plugin by provider ID
 */
export function getAuthPlugin(providerId: string): AuthPlugin | undefined {
	return authPlugins[providerId];
}

/**
 * Check if a provider has an OAuth plugin
 */
export function hasAuthPlugin(providerId: string): boolean {
	return providerId in authPlugins;
}

/**
 * Get all registered auth plugins
 */
export function getAllAuthPlugins(): AuthPlugin[] {
	return Object.values(authPlugins);
}

/**
 * Get the available auth types for a provider
 *
 * All providers support API key authentication.
 * Providers with auth plugins also support OAuth.
 */
export function getAuthTypesForProvider(providerId: string): AuthTypeOption[] {
	const authTypes: AuthTypeOption[] = [{ type: "api_key", label: "API Key" }];

	const plugin = getAuthPlugin(providerId);
	if (plugin) {
		authTypes.push({
			type: "oauth",
			label: plugin.label,
		});
	}

	return authTypes;
}

/**
 * Get the OAuth flow component for a provider
 *
 * Returns the React component to render the OAuth flow UI,
 * or undefined if the provider doesn't support OAuth.
 */
export function getOAuthFlowComponent(
	providerId: string,
):
	| React.ComponentType<{ onComplete: () => void; onCancel: () => void }>
	| undefined {
	const plugin = getAuthPlugin(providerId);
	return plugin?.oauthFlow;
}
