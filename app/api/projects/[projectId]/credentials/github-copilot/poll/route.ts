import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const USER_AGENT = "GitHubCopilotChat/0.35.0";

interface PollRequest {
	deviceCode: string;
	domain: string;
}

interface PollResponse {
	status: "pending" | "success" | "error";
	error?: string;
}

// POST /api/projects/[projectId]/credentials/github-copilot/poll
// Polls GitHub for device authorization status
export async function POST(request: Request) {
	const body: PollRequest = await request.json();

	if (!body.deviceCode || !body.domain) {
		return NextResponse.json(
			{ status: "error", error: "Device code and domain are required" },
			{ status: 400 }
		);
	}

	const accessTokenUrl = `https://${body.domain}/login/oauth/access_token`;

	try {
		const response = await fetch(accessTokenUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: body.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		if (!response.ok) {
			return NextResponse.json({
				status: "error",
				error: "Failed to poll for authorization",
			} as PollResponse);
		}

		const data = await response.json();

		// Authorization successful
		if (data.access_token) {
			// Determine provider ID based on domain
			const isEnterprise = body.domain !== "github.com";
			const providerId = isEnterprise
				? "github-copilot-enterprise"
				: "github-copilot";

			// Store the credential
			// The access_token from OAuth is used as "refresh" token
			// The actual API token is fetched later via copilot_internal/v2/token
			db.createOrUpdateCredential({
				provider: providerId,
				authType: "oauth",
				oauthData: {
					refresh: data.access_token,
					access: "", // Will be fetched on first API call
					expires: 0, // Will be set when access token is fetched
					// Store enterprise URL in a custom field if needed
					...(isEnterprise && { enterpriseUrl: body.domain }),
				},
			});

			return NextResponse.json({ status: "success" } as PollResponse);
		}

		// Still waiting for user authorization
		if (data.error === "authorization_pending") {
			return NextResponse.json({ status: "pending" } as PollResponse);
		}

		// User denied or other error
		if (data.error) {
			return NextResponse.json({
				status: "error",
				error: data.error_description || data.error,
			} as PollResponse);
		}

		// Unknown state, treat as pending
		return NextResponse.json({ status: "pending" } as PollResponse);
	} catch (error) {
		console.error("Poll error:", error);
		return NextResponse.json({
			status: "error",
			error: error instanceof Error ? error.message : "Unknown error",
		} as PollResponse);
	}
}
