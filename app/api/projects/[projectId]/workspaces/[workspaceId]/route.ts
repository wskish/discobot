import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ workspaceId: string }> },
) {
	const { workspaceId } = await params;
	const workspace = db.getWorkspace(workspaceId);
	if (!workspace) {
		return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
	}
	return NextResponse.json(workspace);
}

export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ workspaceId: string }> },
) {
	const { workspaceId } = await params;
	const body = await request.json();
	const workspace = db.updateWorkspace(workspaceId, body);
	if (!workspace) {
		return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
	}
	return NextResponse.json(workspace);
}

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ workspaceId: string }> },
) {
	const { workspaceId } = await params;
	const deleted = db.deleteWorkspace(workspaceId);
	if (!deleted) {
		return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
	}
	return NextResponse.json({ success: true });
}
