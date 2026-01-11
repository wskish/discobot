import type { CredentialAuthType } from "@/lib/api-types";

/**
 * Configuration for an OAuth authentication option
 */
export interface OAuthOption {
	id: string;
	label: string;
	description?: string;
	icon?: "login" | "key";
}

/**
 * Result from starting an OAuth flow
 */
export interface OAuthStartResult {
	url: string;
	verifier: string;
}

/**
 * Result from completing an OAuth flow
 */
export interface OAuthCompleteResult {
	success: boolean;
	error?: string;
}

/**
 * Auth plugin interface
 *
 * Each auth plugin handles authentication for a specific provider
 * that supports OAuth/device flow in addition to API keys.
 */
export interface AuthPlugin {
	/** Provider ID (e.g., "anthropic", "openai") */
	providerId: string;

	/** Display label for the OAuth option */
	label: string;

	/** Available OAuth options for this provider */
	oauthOptions: OAuthOption[];

	/**
	 * Start the OAuth flow
	 * @param optionId - The selected OAuth option ID
	 * @returns URL to open and verifier for token exchange
	 */
	startOAuth(optionId: string): Promise<OAuthStartResult>;

	/**
	 * Complete the OAuth flow by exchanging the code
	 * @param code - Authorization code from user
	 * @param verifier - Verifier from startOAuth
	 * @returns Success/failure result
	 */
	completeOAuth(code: string, verifier: string): Promise<OAuthCompleteResult>;
}

/**
 * Auth type option with label
 */
export interface AuthTypeOption {
	type: CredentialAuthType;
	label: string;
}
