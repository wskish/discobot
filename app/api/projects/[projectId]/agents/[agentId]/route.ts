import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ agentId: string }> },
) {
	const { agentId } = await params;
	const agent = db.getAgent(agentId);
	if (!agent) {
		return NextResponse.json({ error: "Agent not found" }, { status: 404 });
	}
	return NextResponse.json(agent);
}

export async function PUT(
	request: Request,
	{ params }: { params: Promise<{ agentId: string }> },
) {
	const { agentId } = await params;
	const body = await request.json();
	const agent = db.updateAgent(agentId, body);
	if (!agent) {
		return NextResponse.json({ error: "Agent not found" }, { status: 404 });
	}
	return NextResponse.json(agent);
}

export async function DELETE(
	_request: Request,
	{ params }: { params: Promise<{ agentId: string }> },
) {
	const { agentId } = await params;
	const deleted = db.deleteAgent(agentId);
	if (!deleted) {
		return NextResponse.json({ error: "Agent not found" }, { status: 404 });
	}
	return NextResponse.json({ success: true });
}
