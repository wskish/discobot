import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function POST(
	_request: Request,
	{ params }: { params: Promise<{ agentId: string }> },
) {
	const { agentId } = await params;
	const agent = db.duplicateAgent(agentId);
	if (!agent) {
		return NextResponse.json({ error: "Agent not found" }, { status: 404 });
	}
	return NextResponse.json(agent, { status: 201 });
}
