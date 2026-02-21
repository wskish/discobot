/**
 * QuestionManager - coordinates AskUserQuestion tool calls between the Claude SDK
 * callback and the HTTP API that the frontend uses to submit answers.
 *
 * The Claude SDK calls `canUseTool` with toolName="AskUserQuestion" and blocks
 * until we return. We store the pending question here and wait for the frontend
 * to POST an answer. On cancel/clear we reject, which propagates as a cancellation
 * error through the completion runner.
 */

export interface AskUserQuestionOption {
	label: string;
	description: string;
}

export interface AskUserQuestion {
	question: string;
	header: string;
	options: AskUserQuestionOption[];
	multiSelect: boolean;
}

export interface AskUserQuestionInput {
	questions: AskUserQuestion[];
	answers?: Record<string, string>;
}

interface PendingQuestion {
	toolUseID: string;
	questions: AskUserQuestion[];
	resolve: (answers: Record<string, string>) => void;
	reject: (error: Error) => void;
}

class QuestionManager {
	private static instance: QuestionManager | null = null;
	private pending: PendingQuestion | null = null;
	private answeredToolUseIDs = new Set<string>();

	private constructor() {}

	static getInstance(): QuestionManager {
		if (!QuestionManager.instance) {
			QuestionManager.instance = new QuestionManager();
		}
		return QuestionManager.instance;
	}

	/**
	 * Block until the user submits an answer via the HTTP API.
	 * Only one question can be pending at a time; calling this while another
	 * question is pending will cancel the previous one.
	 */
	waitForAnswer(
		toolUseID: string,
		questions: AskUserQuestion[],
	): Promise<Record<string, string>> {
		// Cancel any existing pending question (shouldn't happen in practice)
		if (this.pending) {
			const prev = this.pending;
			this.pending = null;
			prev.reject(
				new Error(
					"AskUserQuestion: replaced by a new question, process cancelled",
				),
			);
		}

		return new Promise<Record<string, string>>((resolve, reject) => {
			this.pending = { toolUseID, questions, resolve, reject };
		});
	}

	/**
	 * Returns the currently pending question, or null if none.
	 * Used by the GET /chat/question polling endpoint.
	 */
	getPendingQuestion(): {
		toolUseID: string;
		questions: AskUserQuestion[];
	} | null {
		if (!this.pending) return null;
		return {
			toolUseID: this.pending.toolUseID,
			questions: this.pending.questions,
		};
	}

	/**
	 * Resolve the pending question with user-supplied answers.
	 * Returns true if there was a matching pending question, false otherwise.
	 */
	submitAnswer(toolUseID: string, answers: Record<string, string>): boolean {
		if (!this.pending || this.pending.toolUseID !== toolUseID) {
			return false;
		}
		const { resolve } = this.pending;
		this.pending = null;
		this.answeredToolUseIDs.add(toolUseID);
		resolve(answers);
		return true;
	}

	/**
	 * Check if a specific toolUseID was answered via submitAnswer().
	 * Used by the GET /chat/question endpoint to distinguish
	 * "answered" from "expired" (cancelled/cleared without answer).
	 */
	wasAnswered(toolUseID: string): boolean {
		return this.answeredToolUseIDs.has(toolUseID);
	}

	/**
	 * Reject all pending questions. Called when the session is cancelled or cleared.
	 * The rejection message contains "cancelled" so the completion runner treats it
	 * as a clean stop rather than an error.
	 */
	cancelAll(
		reason = "AskUserQuestion: user did not answer, process cancelled",
	): void {
		if (!this.pending) return;
		const { reject } = this.pending;
		this.pending = null;
		reject(new Error(reason));
	}
}

export const questionManager = QuestionManager.getInstance();
