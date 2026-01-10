import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ fileId: string }> },
) {
	const { fileId } = await params;
	const file = db.getFile(fileId);
	if (!file) {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
	return NextResponse.json(file);
}
