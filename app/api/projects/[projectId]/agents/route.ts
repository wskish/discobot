import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET() {
	const agents = db.getAgents();
	return NextResponse.json(agents);
}

export async function POST(request: Request) {
	const body = await request.json();
	const agent = db.createAgent(body);
	return NextResponse.json(agent, { status: 201 });
}
