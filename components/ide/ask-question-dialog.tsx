import { Check } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import type { AskUserQuestion, PendingQuestion } from "@/lib/api-types";
import { cn } from "@/lib/utils";

const OTHER_LABEL = "__other__";
const AUTO_ADVANCE_DELAY = 300;

interface QuestionWizardContentProps {
	pendingQuestion: PendingQuestion;
	onSubmit: (
		toolUseID: string,
		answers: Record<string, string>,
	) => Promise<void>;
}

/**
 * QuestionWizardContent — the core wizard UI for AskUserQuestion.
 * Renders step tabs, question blocks, and navigation buttons.
 * Can be used inline (tool renderer) or wrapped in a Dialog.
 */
export function QuestionWizardContent({
	pendingQuestion,
	onSubmit,
}: QuestionWizardContentProps) {
	const { toolUseID, questions } = pendingQuestion;

	const [currentStep, setCurrentStep] = React.useState(0);

	const [answers, setAnswers] = React.useState<Record<string, string>>(() => {
		// Pre-populate with first option for single-select questions
		const initial: Record<string, string> = {};
		for (const q of questions) {
			if (!q.multiSelect && q.options.length > 0) {
				initial[q.question] = q.options[0].label;
			}
		}
		return initial;
	});

	// Track which questions have "Other" selected (free-text mode)
	const [otherSelected, setOtherSelected] = React.useState<
		Record<string, boolean>
	>({});
	// Track the free-text input value for "Other"
	const [otherText, setOtherText] = React.useState<Record<string, string>>({});

	const [isSubmitting, setIsSubmitting] = React.useState(false);

	const isStepAnswered = React.useCallback(
		(stepIndex: number) => {
			const q = questions[stepIndex];
			if (otherSelected[q.question]) {
				return (otherText[q.question]?.trim().length ?? 0) > 0;
			}
			return (answers[q.question]?.trim().length ?? 0) > 0;
		},
		[questions, answers, otherSelected, otherText],
	);

	const allAnswered = questions.every((_, i) => isStepAnswered(i));
	const isLastStep = currentStep === questions.length - 1;
	const currentIsAnswered = isStepAnswered(currentStep);

	// Find the next unanswered step (for auto-advance)
	const findNextUnanswered = React.useCallback(
		(afterStep: number) => {
			for (let i = afterStep + 1; i < questions.length; i++) {
				if (!isStepAnswered(i)) return i;
			}
			// All subsequent steps answered — stay on current or go to last
			return null;
		},
		[questions, isStepAnswered],
	);

	// Auto-advance for single-select after choosing an option
	const autoAdvanceTimeout = React.useRef<NodeJS.Timeout | null>(null);

	const scheduleAutoAdvance = React.useCallback(() => {
		if (autoAdvanceTimeout.current) {
			clearTimeout(autoAdvanceTimeout.current);
		}
		autoAdvanceTimeout.current = setTimeout(() => {
			const next = findNextUnanswered(currentStep);
			if (next !== null) {
				setCurrentStep(next);
			} else if (!isLastStep) {
				setCurrentStep(currentStep + 1);
			}
		}, AUTO_ADVANCE_DELAY);
	}, [currentStep, findNextUnanswered, isLastStep]);

	React.useEffect(() => {
		return () => {
			if (autoAdvanceTimeout.current) {
				clearTimeout(autoAdvanceTimeout.current);
			}
		};
	}, []);

	const handleOptionChange = (
		question: AskUserQuestion,
		optionLabel: string,
		checked: boolean,
	) => {
		// Handle "Other" selection
		if (optionLabel === OTHER_LABEL) {
			if (question.multiSelect) {
				setOtherSelected((prev) => ({
					...prev,
					[question.question]: checked,
				}));
				if (!checked) {
					// Clear the other text from answers
					setOtherText((prev) => ({ ...prev, [question.question]: "" }));
				}
			} else {
				setOtherSelected((prev) => ({
					...prev,
					[question.question]: true,
				}));
				// Clear the regular answer since "Other" is now selected
				setAnswers((prev) => ({ ...prev, [question.question]: "" }));
			}
			return;
		}

		if (question.multiSelect) {
			const current =
				answers[question.question]?.split(", ").filter(Boolean) ?? [];
			const updated = checked
				? [...current, optionLabel]
				: current.filter((l) => l !== optionLabel);
			setAnswers((prev) => ({
				...prev,
				[question.question]: updated.join(", "),
			}));
		} else {
			// Deselect "Other" when picking a regular option
			setOtherSelected((prev) => ({
				...prev,
				[question.question]: false,
			}));
			setOtherText((prev) => ({ ...prev, [question.question]: "" }));
			setAnswers((prev) => ({
				...prev,
				[question.question]: optionLabel,
			}));

			// Auto-advance for single-select
			scheduleAutoAdvance();
		}
	};

	const handleOtherTextChange = (questionKey: string, text: string) => {
		setOtherText((prev) => ({ ...prev, [questionKey]: text }));
	};

	// Build final answers map, substituting "Other" text where applicable
	const buildFinalAnswers = React.useCallback(() => {
		const final: Record<string, string> = {};
		for (const q of questions) {
			if (otherSelected[q.question]) {
				if (q.multiSelect) {
					// Combine regular selections with "Other" text
					const regular = answers[q.question] || "";
					const other = otherText[q.question]?.trim() || "";
					const parts = [regular, other].filter(Boolean);
					final[q.question] = parts.join(", ");
				} else {
					final[q.question] = otherText[q.question]?.trim() || "";
				}
			} else {
				final[q.question] = answers[q.question] || "";
			}
		}
		return final;
	}, [questions, answers, otherSelected, otherText]);

	const handleSubmit = async () => {
		if (!allAnswered || isSubmitting) return;
		setIsSubmitting(true);
		try {
			await onSubmit(toolUseID, buildFinalAnswers());
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleContinue = () => {
		if (!currentIsAnswered) return;
		const next = findNextUnanswered(currentStep);
		if (next !== null) {
			setCurrentStep(next);
		} else if (!isLastStep) {
			setCurrentStep(currentStep + 1);
		}
	};

	return (
		<>
			{/* Header */}
			<div>
				<h3 className="text-base font-semibold">Agent needs input</h3>
				<p className="text-sm text-muted-foreground">
					Answer to help the agent continue with your task.
				</p>
			</div>

			{/* Step tabs */}
			{questions.length > 1 && (
				<StepTabs
					questions={questions}
					currentStep={currentStep}
					isStepAnswered={isStepAnswered}
					onStepClick={setCurrentStep}
				/>
			)}

			{/* All questions rendered in same grid cell — container sizes to tallest */}
			<div className="grid py-1">
				{questions.map((q, i) => (
					<div
						key={q.question}
						className="col-start-1 row-start-1"
						style={{
							visibility: i === currentStep ? "visible" : "hidden",
						}}
					>
						<QuestionBlock
							question={q}
							currentAnswer={answers[q.question] ?? ""}
							otherSelected={otherSelected[q.question] ?? false}
							otherText={otherText[q.question] ?? ""}
							onOptionChange={handleOptionChange}
							onOtherTextChange={(text) =>
								handleOtherTextChange(q.question, text)
							}
							disabled={isSubmitting}
						/>
					</div>
				))}
			</div>

			{/* Navigation footer */}
			<div className="flex justify-between pt-2">
				<div>
					{currentStep > 0 && (
						<Button
							variant="ghost"
							onClick={() => setCurrentStep(currentStep - 1)}
							disabled={isSubmitting}
						>
							Back
						</Button>
					)}
				</div>
				<div className="flex gap-2">
					{isLastStep || allAnswered ? (
						<Button
							onClick={handleSubmit}
							disabled={!allAnswered || isSubmitting}
						>
							{isSubmitting ? "Submitting..." : "Submit"}
						</Button>
					) : (
						<Button
							onClick={handleContinue}
							disabled={!currentIsAnswered || isSubmitting}
						>
							Continue
						</Button>
					)}
				</div>
			</div>
		</>
	);
}

// ============================================================================
// Step Tabs
// ============================================================================

interface StepTabsProps {
	questions: AskUserQuestion[];
	currentStep: number;
	isStepAnswered: (index: number) => boolean;
	onStepClick: (index: number) => void;
}

function StepTabs({
	questions,
	currentStep,
	isStepAnswered,
	onStepClick,
}: StepTabsProps) {
	return (
		<div className="flex gap-1">
			{questions.map((q, i) => {
				const answered = isStepAnswered(i);
				const active = i === currentStep;
				return (
					<button
						key={q.header}
						type="button"
						onClick={() => onStepClick(i)}
						className={cn(
							"flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
							active
								? "bg-primary/10 text-primary border border-primary/30"
								: "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent",
						)}
					>
						{answered ? (
							<Check className="size-3.5 text-primary shrink-0" />
						) : (
							<span
								className={cn(
									"size-3.5 shrink-0 rounded-full border text-[10px] font-semibold flex items-center justify-center",
									active
										? "border-primary text-primary"
										: "border-muted-foreground/40 text-muted-foreground/60",
								)}
							>
								{i + 1}
							</span>
						)}
						{q.header}
					</button>
				);
			})}
		</div>
	);
}

// ============================================================================
// Question Block
// ============================================================================

interface QuestionBlockProps {
	question: AskUserQuestion;
	currentAnswer: string;
	otherSelected: boolean;
	otherText: string;
	onOptionChange: (
		question: AskUserQuestion,
		optionLabel: string,
		checked: boolean,
	) => void;
	onOtherTextChange: (text: string) => void;
	disabled: boolean;
}

function QuestionBlock({
	question,
	currentAnswer,
	otherSelected,
	otherText,
	onOptionChange,
	onOtherTextChange,
	disabled,
}: QuestionBlockProps) {
	const selectedLabels = currentAnswer.split(", ").filter(Boolean);
	const otherInputRef = React.useRef<HTMLInputElement>(null);

	// Focus the "Other" text input when "Other" is selected
	React.useEffect(() => {
		if (otherSelected && otherInputRef.current) {
			otherInputRef.current.focus();
		}
	}, [otherSelected]);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-sm font-medium">{question.question}</p>
			<div className="flex flex-col gap-1.5">
				{question.options.map((option) => {
					const isSelected =
						!otherSelected && selectedLabels.includes(option.label);
					return (
						<OptionCard
							key={option.label}
							label={option.label}
							description={option.description}
							isSelected={isSelected}
							inputType={question.multiSelect ? "checkbox" : "radio"}
							inputName={`question-${question.question}`}
							disabled={disabled}
							onChange={(checked) =>
								onOptionChange(question, option.label, checked)
							}
						/>
					);
				})}

				{/* "Other" option */}
				<label
					className={cn(
						"flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
						otherSelected
							? "border-primary bg-primary/5"
							: "border-border hover:bg-muted/50",
						disabled && "cursor-not-allowed opacity-60",
					)}
				>
					<input
						type={question.multiSelect ? "checkbox" : "radio"}
						name={`question-${question.question}`}
						value={OTHER_LABEL}
						checked={otherSelected}
						onChange={(e) =>
							onOptionChange(question, OTHER_LABEL, e.target.checked)
						}
						disabled={disabled}
						className="mt-0.5 shrink-0 accent-primary"
					/>
					<div className="flex flex-col gap-1.5 flex-1">
						<span className="text-sm font-medium leading-tight">Other</span>
						{otherSelected && (
							<input
								ref={otherInputRef}
								type="text"
								value={otherText}
								onChange={(e) => onOtherTextChange(e.target.value)}
								placeholder="Type your answer..."
								disabled={disabled}
								className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground"
								onClick={(e) => e.stopPropagation()}
							/>
						)}
					</div>
				</label>
			</div>
		</div>
	);
}

// ============================================================================
// Option Card
// ============================================================================

interface OptionCardProps {
	label: string;
	description?: string;
	isSelected: boolean;
	inputType: "radio" | "checkbox";
	inputName: string;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}

function OptionCard({
	label,
	description,
	isSelected,
	inputType,
	inputName,
	disabled,
	onChange,
}: OptionCardProps) {
	return (
		<label
			className={cn(
				"flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer transition-colors",
				isSelected
					? "border-primary bg-primary/5"
					: "border-border hover:bg-muted/50",
				disabled && "cursor-not-allowed opacity-60",
			)}
		>
			<input
				type={inputType}
				name={inputName}
				value={label}
				checked={isSelected}
				onChange={(e) => onChange(e.target.checked)}
				disabled={disabled}
				className="mt-0.5 shrink-0 accent-primary"
			/>
			<div className="flex flex-col gap-0.5">
				<span className="text-sm font-medium leading-tight">{label}</span>
				{description && (
					<span className="text-xs text-muted-foreground">{description}</span>
				)}
			</div>
		</label>
	);
}
