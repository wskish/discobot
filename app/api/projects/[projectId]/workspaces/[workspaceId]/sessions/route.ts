import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ workspaceId: string }> },
) {
	const { workspaceId } = await params;
	const sessions = db.getSessions(workspaceId);
	return NextResponse.json(sessions);
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ workspaceId: string }> },
) {
	const { workspaceId } = await params;
	const body = await request.json();
	const session = db.createSession(workspaceId, body);
	if (!session) {
		return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
	}
	return NextResponse.json(session, { status: 201 });
}
