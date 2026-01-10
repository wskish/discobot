import { convertToModelMessages, streamText, type UIMessage } from "ai";

export const maxDuration = 30;

export async function POST(req: Request) {
	const { messages }: { messages: UIMessage[] } = await req.json();

	const result = streamText({
		model: "openai/gpt-4o-mini",
		system:
			"You are a helpful AI assistant integrated into an IDE-like interface. Be concise and helpful.",
		messages: await convertToModelMessages(messages),
		abortSignal: req.signal,
	});

	return result.toUIMessageStreamResponse();
}
