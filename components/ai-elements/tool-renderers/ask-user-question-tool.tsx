import type { UIMessage } from "ai";
import * as React from "react";
import { QuestionWizardContent } from "@/components/ide/ask-question-dialog";
import { api } from "@/lib/api-client";
import type { AskUserQuestion, PendingQuestion } from "@/lib/api-types";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import { cn } from "@/lib/utils";
import { Tool, ToolContent, ToolHeader } from "../tool";
import type { ToolRendererProps } from "../tool-schemas";

type DynamicToolPart = Extract<
	UIMessage["parts"][number],
	{ type: "dynamic-tool" }
>;

interface AskUserQuestionToolProps {
	part: DynamicToolPart;
}

/**
 * Inline tool renderer for AskUserQuestion.
 *
 * - approval-requested: fetches question from backend, shows wizard or auto-approves
 * - All other states: shows a pretty Q&A summary with standard Tool chrome + raw toggle
 */
export default function AskUserQuestionTool({
	part,
}: AskUserQuestionToolProps) {
	// approval-requested → show interactive wizard
	if (part.state === "approval-requested") {
		return <AskUserQuestionActive part={part} />;
	}

	// All other states (output-available, approval-responded, etc.) → show resolved view
	return <AskUserQuestionResolved part={part} />;
}

// ============================================================================
// Active (approval-requested) — fetches question, shows wizard
// ============================================================================

function AskUserQuestionActive({ part }: { part: DynamicToolPart }) {
	const { selectedSessionId, addToolApprovalResponse } =
		useSessionViewContext();
	const [question, setQuestion] = React.useState<PendingQuestion | null>(null);
	const [status, setStatus] = React.useState<
		"loading" | "pending" | "answered" | "error"
	>("loading");

	const approvalId =
		"approval" in part &&
		part.approval &&
		typeof part.approval === "object" &&
		"id" in part.approval
			? (part.approval.id as string)
			: null;

	React.useEffect(() => {
		if (!selectedSessionId || !approvalId) return;

		let cancelled = false;
		setStatus("loading");

		const fetchQuestion = async () => {
			try {
				const result = await api.getChatQuestion(selectedSessionId, approvalId);
				if (cancelled) return;

				if (result.status === "pending" && result.question) {
					setQuestion(result.question);
					setStatus("pending");
				} else if (result.status === "expired") {
					// Question expired without user answer — reject the tool approval
					setStatus("answered");
					addToolApprovalResponse({ id: approvalId, approved: false });
				} else {
					// status === "answered" — user already submitted an answer
					setStatus("answered");
					addToolApprovalResponse({ id: approvalId, approved: true });
				}
			} catch (_err) {
				if (!cancelled) setStatus("error");
			}
		};
		fetchQuestion();
		return () => {
			cancelled = true;
		};
	}, [selectedSessionId, approvalId, addToolApprovalResponse]);

	const handleSubmit = React.useCallback(
		async (toolUseID: string, answers: Record<string, string>) => {
			if (!selectedSessionId || !approvalId) return;
			await api.submitChatAnswer(selectedSessionId, { toolUseID, answers });
			addToolApprovalResponse({ id: approvalId, approved: true });
			setStatus("answered");
			setQuestion(null);
		},
		[selectedSessionId, approvalId, addToolApprovalResponse],
	);

	if (status === "loading") {
		return (
			<div className="text-sm text-muted-foreground py-2 animate-pulse">
				Loading question...
			</div>
		);
	}

	if (status === "error") {
		return (
			<div className="text-sm text-destructive py-2">
				Failed to load question
			</div>
		);
	}

	if (status === "answered" || !question) {
		return (
			<div className="text-sm text-muted-foreground py-2">
				Question answered
			</div>
		);
	}

	return (
		<div className="rounded-lg border bg-card p-4 space-y-3">
			<QuestionWizardContent
				pendingQuestion={question}
				onSubmit={handleSubmit}
			/>
		</div>
	);
}

// ============================================================================
// Resolved — shows questions + answers, with raw toggle
// ============================================================================

/**
 * Try to extract "question"="answer" pairs from the output text.
 * The agent-api produces strings like:
 *   "What environment?"="Production", "Which features?"="SSE, AgentFS"
 * Returns a Map<question, answer> if any pairs found, null otherwise.
 */
function parseAnswersFromText(text: string): Map<string, string> | null {
	// Match "key"="value" pairs (handles escaped quotes inside values)
	const pairRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"="([^"\\]*(?:\\.[^"\\]*)*)"/g;
	const pairs = new Map<string, string>();
	for (const match of text.matchAll(pairRegex)) {
		pairs.set(match[1], match[2]);
	}
	return pairs.size > 0 ? pairs : null;
}

function AskUserQuestionResolved({ part }: { part: DynamicToolPart }) {
	const [showRaw, setShowRaw] = React.useState(false);

	const input = part.input as Record<string, unknown> | undefined;
	const questions = (input?.questions ?? []) as AskUserQuestion[];

	const outputText =
		typeof part.output === "string"
			? part.output
			: part.output != null
				? String(part.output)
				: null;

	// Optimistically try to parse "question"="answer" pairs from the response
	const parsedAnswers = React.useMemo(
		() => (outputText ? parseAnswersFromText(outputText) : null),
		[outputText],
	);

	return (
		<Tool>
			<ToolHeader
				type={part.type}
				state={part.state}
				toolName={part.toolName}
				title="Agent Question"
				showIcon
				isRaw={showRaw}
				onToggleRaw={() => setShowRaw(!showRaw)}
			/>
			<ToolContent>
				{showRaw ? (
					<AskUserQuestionRaw
						input={part.input}
						output={part.output}
						errorText={part.errorText}
						state={part.state}
						toolCallId={part.toolCallId}
					/>
				) : (
					<div className="p-4 space-y-3">
						{parsedAnswers && questions.length > 0 ? (
							/* Matched Q&A pairs — show question + answer together */
							<div className="space-y-2">
								{questions.map((q) => {
									const answer = parsedAnswers.get(q.question);
									return (
										<div key={q.question} className="space-y-0.5">
											<div className="text-sm font-medium">{q.question}</div>
											<div className="text-sm text-muted-foreground">
												{answer ?? "No answer"}
											</div>
										</div>
									);
								})}
							</div>
						) : (
							/* Could not parse pairs — show questions + raw text fallback */
							<>
								{questions.length > 0 && (
									<div className="space-y-1.5">
										<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Questions
										</h4>
										<ul className="space-y-1">
											{questions.map((q) => (
												<li key={q.question} className="text-sm">
													{q.question}
												</li>
											))}
										</ul>
									</div>
								)}
								{outputText && (
									<div className="space-y-1.5">
										<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Response
										</h4>
										<p className="text-sm whitespace-pre-wrap">{outputText}</p>
									</div>
								)}
							</>
						)}

						{part.errorText && (
							<div className="space-y-1.5">
								<h4 className="font-medium text-destructive text-xs uppercase tracking-wide">
									Error
								</h4>
								<p className="text-sm text-destructive">{part.errorText}</p>
							</div>
						)}
					</div>
				)}
			</ToolContent>
		</Tool>
	);
}

// ============================================================================
// Raw view — JSON dump of input/output
// ============================================================================

function AskUserQuestionRaw({ input, output, errorText }: ToolRendererProps) {
	return (
		<div className="space-y-2 p-4">
			{input != null && (
				<div>
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-1">
						Parameters
					</h4>
					<pre className="rounded-md bg-muted/50 p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words">
						{JSON.stringify(input, null, 2)}
					</pre>
				</div>
			)}
			{(output != null || errorText) && (
				<div>
					<h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-1">
						{errorText ? "Error" : "Result"}
					</h4>
					<pre
						className={cn(
							"rounded-md p-3 text-xs overflow-x-auto whitespace-pre-wrap break-words",
							errorText
								? "bg-destructive/10 text-destructive"
								: "bg-muted/50 text-foreground",
						)}
					>
						{errorText ||
							(typeof output === "string"
								? output
								: JSON.stringify(output, null, 2))}
					</pre>
				</div>
			)}
		</div>
	);
}
