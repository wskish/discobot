import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";

interface ExchangeRequest {
	code: string;
	verifier: string;
}

interface TokenResponse {
	id_token?: string;
	access_token: string;
	refresh_token: string;
	expires_in?: number;
}

interface IdTokenClaims {
	chatgpt_account_id?: string;
	organizations?: Array<{ id: string }>;
	email?: string;
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload = parts[1];
		// Handle base64url decoding
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const jsonStr = atob(base64);
		return JSON.parse(jsonStr);
	} catch {
		return undefined;
	}
}

function extractAccountId(tokens: TokenResponse): string | undefined {
	const extractFromClaims = (claims: IdTokenClaims): string | undefined => {
		return (
			claims.chatgpt_account_id ||
			claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
			claims.organizations?.[0]?.id
		);
	};

	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token);
		const accountId = claims && extractFromClaims(claims);
		if (accountId) return accountId;
	}
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token);
		return claims ? extractFromClaims(claims) : undefined;
	}
	return undefined;
}

// POST /api/projects/[projectId]/credentials/codex/exchange
// Exchange authorization code for tokens
export async function POST(request: Request) {
	const body: ExchangeRequest = await request.json();

	if (!body.code || !body.verifier) {
		return NextResponse.json(
			{ success: false, error: "Code and verifier are required" },
			{ status: 400 },
		);
	}

	try {
		const response = await fetch(`${ISSUER}/oauth/token`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: body.code,
				redirect_uri: "http://localhost:1455/auth/callback",
				client_id: CLIENT_ID,
				code_verifier: body.verifier,
			}).toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error("Token exchange failed:", response.status, errorText);
			return NextResponse.json(
				{
					success: false,
					error: `Token exchange failed: ${response.status}`,
				},
				{ status: 400 },
			);
		}

		const tokens: TokenResponse = await response.json();

		// Extract account ID from tokens (for organization subscriptions)
		const accountId = extractAccountId(tokens);

		// Store the credential
		db.createOrUpdateCredential({
			provider: "codex",
			authType: "oauth",
			oauthData: {
				refresh: tokens.refresh_token,
				access: tokens.access_token,
				expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				// Note: accountId would need to be added to OAuthData type
				// For now, we store what we can
			},
		});

		return NextResponse.json({ success: true, accountId });
	} catch (error) {
		console.error("Token exchange error:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
