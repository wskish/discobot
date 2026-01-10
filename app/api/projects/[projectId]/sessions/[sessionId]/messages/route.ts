import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const messages = db.getMessages(sessionId);
	return NextResponse.json(messages);
}
