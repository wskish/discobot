import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function POST(request: Request) {
	const body = await request.json();
	const { agentId } = body;

	if (!agentId) {
		return NextResponse.json({ error: "agentId is required" }, { status: 400 });
	}

	const agent = db.setDefaultAgent(agentId);

	if (!agent) {
		return NextResponse.json({ error: "Agent not found" }, { status: 404 });
	}

	return NextResponse.json(agent);
}
