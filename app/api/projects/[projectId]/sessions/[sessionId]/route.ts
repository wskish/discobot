import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const session = db.getSession(sessionId);
	if (!session) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}
	return NextResponse.json(session);
}

export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const body = await request.json();
	const session = db.updateSession(sessionId, body);
	if (!session) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}
	return NextResponse.json(session);
}

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const deleted = db.deleteSession(sessionId);
	if (!deleted) {
		return NextResponse.json({ error: "Session not found" }, { status: 404 });
	}
	return NextResponse.json({ success: true });
}
