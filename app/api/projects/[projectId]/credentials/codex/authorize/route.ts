import { NextResponse } from "next/server";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";

// Generate PKCE challenge/verifier
async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	// Generate random verifier (43 chars)
	const chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const bytes = crypto.getRandomValues(new Uint8Array(43));
	const verifier = Array.from(bytes)
		.map((b) => chars[b % chars.length])
		.join("");

	// Generate challenge from verifier
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = new Uint8Array(hashBuffer);
	const challenge = btoa(String.fromCharCode(...hashArray))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	return { verifier, challenge };
}

// Generate random state
function generateState(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// POST /api/projects/[projectId]/credentials/codex/authorize
// Generates PKCE and returns authorization URL for Codex/ChatGPT
export async function POST() {
	const pkce = await generatePKCE();
	const state = generateState();

	// Build authorize URL
	// Using a special redirect_uri that displays the code for manual entry
	// Since we can't register our own callback with OpenAI's OAuth
	const params = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		// Use localhost callback - user will copy the code from URL
		redirect_uri: "http://localhost:1455/auth/callback",
		scope: "openid profile email offline_access",
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: "opencode",
	});

	const url = `${ISSUER}/oauth/authorize?${params.toString()}`;

	return NextResponse.json({
		url,
		verifier: pkce.verifier,
		state,
	});
}
