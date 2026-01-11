import { NextResponse } from "next/server";
import type { OAuthExchangeRequest } from "@/lib/api-types";
import { db } from "@/lib/mock-db";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// POST /api/projects/[projectId]/credentials/anthropic/exchange
// Exchange authorization code for tokens (server-side to avoid CORS)
export async function POST(request: Request) {
	const body: OAuthExchangeRequest = await request.json();

	if (!body.code || !body.verifier) {
		return NextResponse.json(
			{ success: false, error: "Code and verifier are required" },
			{ status: 400 },
		);
	}

	// The code may have a state appended after #
	const splits = body.code.split("#");
	const code = splits[0];
	const state = splits[1] || body.verifier;

	try {
		const response = await fetch(
			"https://console.anthropic.com/v1/oauth/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					code,
					state,
					grant_type: "authorization_code",
					client_id: CLIENT_ID,
					redirect_uri: "https://console.anthropic.com/oauth/code/callback",
					code_verifier: body.verifier,
				}),
			},
		);

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

		const json = await response.json();

		// Store the credential
		db.createOrUpdateCredential({
			provider: "anthropic",
			authType: "oauth",
			oauthData: {
				refresh: json.refresh_token,
				access: json.access_token,
				expires: Date.now() + json.expires_in * 1000,
			},
		});

		return NextResponse.json({ success: true });
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
