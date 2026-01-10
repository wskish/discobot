import { NextResponse } from "next/server";

export async function GET() {
	// Return mock terminal history
	return NextResponse.json([
		{ type: "input", content: "ssh user@dev-server.local" },
		{ type: "output", content: "Welcome to Ubuntu 22.04.3 LTS" },
		{ type: "input", content: "cd /var/www/my-app" },
		{ type: "input", content: "git status" },
	]);
}
