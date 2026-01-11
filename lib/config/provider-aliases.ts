/**
 * Provider Aliases Configuration
 *
 * Maps alternative names/aliases to provider IDs.
 * This allows users to search for providers using common alternative names.
 *
 * Example: typing "claude" will match "anthropic"
 */

/**
 * Map of provider ID to array of aliases
 * Aliases are case-insensitive during search
 */
export const PROVIDER_ALIASES: Record<string, string[]> = {
	// Anthropic / Claude
	anthropic: ["claude", "claude ai", "sonnet", "opus", "haiku"],

	// OpenAI / ChatGPT
	openai: ["chatgpt", "gpt", "gpt-4", "gpt-5", "dall-e", "whisper"],

	// Codex (ChatGPT API)
	codex: ["chatgpt pro", "chatgpt plus", "openai codex"],

	// GitHub Copilot
	"github-copilot": ["copilot", "gh copilot"],

	// Google
	google: ["gemini", "bard", "palm", "vertex"],
	"google-vertex": ["vertex ai", "gcp ai"],

	// Mistral
	mistral: ["mixtral", "mistral ai"],

	// Cohere
	cohere: ["command", "command-r"],

	// Perplexity
	perplexity: ["pplx", "perplexity ai"],

	// Groq
	groq: ["groq cloud", "llama groq"],

	// Together AI
	togetherai: ["together", "together ai"],

	// Fireworks
	"fireworks-ai": ["fireworks", "fireworks ai"],

	// DeepSeek
	deepseek: ["deepseek ai", "deepseek coder"],

	// xAI
	xai: ["grok", "x ai"],

	// Amazon Bedrock
	"amazon-bedrock": ["bedrock", "aws bedrock", "aws ai"],

	// Azure
	azure: ["azure openai", "azure ai"],

	// Hugging Face
	huggingface: ["hf", "hugging face", "transformers"],

	// Ollama
	"ollama-cloud": ["ollama"],

	// Cerebras
	cerebras: ["cerebras ai"],

	// Replicate
	replicate: ["replicate ai"],
};

/**
 * Get all aliases for a provider ID
 */
export function getProviderAliases(providerId: string): string[] {
	return PROVIDER_ALIASES[providerId] || [];
}

/**
 * Check if a search query matches any alias for a provider
 */
export function matchesProviderAlias(
	providerId: string,
	query: string,
): boolean {
	const aliases = PROVIDER_ALIASES[providerId];
	if (!aliases) return false;

	const lowerQuery = query.toLowerCase();
	return aliases.some((alias) => alias.toLowerCase().includes(lowerQuery));
}

/**
 * Get provider ID from an alias (reverse lookup)
 * Returns undefined if no match found
 */
export function getProviderIdFromAlias(alias: string): string | undefined {
	const lowerAlias = alias.toLowerCase();
	for (const [providerId, aliases] of Object.entries(PROVIDER_ALIASES)) {
		if (aliases.some((a) => a.toLowerCase() === lowerAlias)) {
			return providerId;
		}
	}
	return undefined;
}
