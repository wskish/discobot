import { NextResponse } from "next/server";
import { db } from "@/lib/mock-db";

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	const query = searchParams.get("q") || "";
	const type = searchParams.get("type") as "path" | "repo" | undefined;

	const suggestions = db.getSuggestions(query, type);
	return NextResponse.json(suggestions);
}
