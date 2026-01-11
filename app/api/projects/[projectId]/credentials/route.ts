import { NextResponse } from "next/server";
import type { CreateCredentialRequest } from "@/lib/api-types";
import { db } from "@/lib/mock-db";

// GET /api/projects/[projectId]/credentials - List all credentials (safe info only)
export async function GET() {
	const credentials = db.getCredentials();
	return NextResponse.json(credentials);
}

// POST /api/projects/[projectId]/credentials - Create or update a credential
export async function POST(request: Request) {
	const body: CreateCredentialRequest = await request.json();

	if (!body.provider) {
		return NextResponse.json(
			{ error: "Provider is required" },
			{ status: 400 },
		);
	}

	if (!body.authType) {
		return NextResponse.json(
			{ error: "Auth type is required" },
			{ status: 400 },
		);
	}

	if (body.authType === "api_key" && !body.apiKey) {
		return NextResponse.json(
			{ error: "API key is required for api_key auth type" },
			{ status: 400 },
		);
	}

	if (body.authType === "oauth" && !body.oauthData) {
		return NextResponse.json(
			{ error: "OAuth data is required for oauth auth type" },
			{ status: 400 },
		);
	}

	const credential = db.createOrUpdateCredential(body);
	return NextResponse.json(credential, { status: 201 });
}
