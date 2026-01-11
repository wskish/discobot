import { NextResponse } from "next/server";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Generate PKCE challenge/verifier
async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	// Generate random verifier
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	const verifier = btoa(String.fromCharCode(...array))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	// Generate challenge from verifier
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = new Uint8Array(hashBuffer);
	const challenge = btoa(String.fromCharCode(...hashArray))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	return { verifier, challenge };
}

// POST /api/projects/[projectId]/credentials/anthropic/authorize
// Generates PKCE and returns authorization URL
export async function POST(request: Request) {
	const body = await request.json();
	const mode = body.mode === "console" ? "console" : "max";

	const pkce = await generatePKCE();

	const baseUrl =
		mode === "console" ? "https://console.anthropic.com" : "https://claude.ai";

	const url = new URL(`${baseUrl}/oauth/authorize`);
	url.searchParams.set("code", "true");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set(
		"redirect_uri",
		"https://console.anthropic.com/oauth/code/callback",
	);
	url.searchParams.set(
		"scope",
		"org:create_api_key user:profile user:inference",
	);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", pkce.verifier);

	return NextResponse.json({
		url: url.toString(),
		verifier: pkce.verifier,
	});
}
