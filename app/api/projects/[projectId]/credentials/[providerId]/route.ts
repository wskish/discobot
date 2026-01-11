import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

// GET /api/projects/[projectId]/credentials/[providerId] - Get credential info
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string; providerId: string }> },
) {
	const { providerId } = await params;
	const credential = db.getCredentialInfo(providerId);

	if (!credential) {
		return NextResponse.json(
			{ error: "Credential not found" },
			{ status: 404 },
		);
	}

	return NextResponse.json(credential);
}

// DELETE /api/projects/[projectId]/credentials/[providerId] - Delete a credential
export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ projectId: string; providerId: string }> },
) {
	const { providerId } = await params;
	const deleted = db.deleteCredential(providerId);

	if (!deleted) {
		return NextResponse.json(
			{ error: "Credential not found" },
			{ status: 404 },
		);
	}

	return NextResponse.json({ success: true });
}
