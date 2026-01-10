import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET() {
	const workspaces = db.getWorkspaces();
	return NextResponse.json(workspaces);
}

export async function POST(request: Request) {
	const body = await request.json();
	const workspace = db.createWorkspace(body);
	return NextResponse.json(workspace, { status: 201 });
}
