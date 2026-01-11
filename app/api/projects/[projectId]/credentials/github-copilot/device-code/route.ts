import { NextResponse } from "next/server";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const USER_AGENT = "GitHubCopilotChat/0.35.0";

interface DeviceCodeRequest {
	deploymentType?: "github.com" | "enterprise";
	enterpriseUrl?: string;
}

interface DeviceCodeResponse {
	verificationUri: string;
	userCode: string;
	deviceCode: string;
	interval: number;
	expiresIn: number;
	domain: string;
}

function normalizeDomain(url: string): string {
	return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// POST /api/projects/[projectId]/credentials/github-copilot/device-code
// Initiates the GitHub device authorization flow
export async function POST(request: Request) {
	const body: DeviceCodeRequest = await request.json();
	const deploymentType = body.deploymentType || "github.com";

	let domain = "github.com";
	if (deploymentType === "enterprise" && body.enterpriseUrl) {
		domain = normalizeDomain(body.enterpriseUrl);
	}

	const deviceCodeUrl = `https://${domain}/login/device/code`;

	try {
		const response = await fetch(deviceCodeUrl, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				scope: "read:user",
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error("Device code request failed:", response.status, errorText);
			return NextResponse.json(
				{ error: "Failed to initiate device authorization" },
				{ status: 400 },
			);
		}

		const data = await response.json();

		const result: DeviceCodeResponse = {
			verificationUri: data.verification_uri,
			userCode: data.user_code,
			deviceCode: data.device_code,
			interval: data.interval || 5,
			expiresIn: data.expires_in || 900,
			domain,
		};

		return NextResponse.json(result);
	} catch (error) {
		console.error("Device code error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			{ status: 500 },
		);
	}
}
