import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ sessionId: string }> },
) {
	const { sessionId } = await params;
	const files = db.getSessionFiles(sessionId);
	return NextResponse.json(files);
}
