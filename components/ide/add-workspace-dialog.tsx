"use client";

import { AlertCircle, Check, GitBranch, Github, HardDrive } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CreateWorkspaceRequest } from "@/lib/api-types";
import { useSuggestions } from "@/lib/hooks/use-suggestions";
import { cn } from "@/lib/utils";

type InputType = "unknown" | "local" | "git" | "github";

interface ValidationResult {
	isValid: boolean;
	type: InputType;
	error?: string;
}

function detectInputType(input: string): InputType {
	if (!input.trim()) return "unknown";

	const trimmed = input.trim();

	if (
		trimmed.match(/^(https?:\/\/)?(www\.)?github\.com\//) ||
		trimmed.match(/^git@github\.com:/) ||
		trimmed.match(/^github\.com\//)
	) {
		return "github";
	}

	if (
		trimmed.match(/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/) ||
		trimmed.match(/\.git$/) ||
		trimmed.match(/^[a-z]+@[a-z0-9.-]+:/)
	) {
		return "git";
	}

	if (
		trimmed.startsWith("~") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		trimmed.match(/^[A-Z]:\\/) ||
		trimmed.match(/^\.\.\//)
	) {
		return "local";
	}

	return "unknown";
}

function validateInput(input: string): ValidationResult {
	const type = detectInputType(input);

	if (!input.trim()) {
		return { isValid: false, type: "unknown", error: undefined };
	}

	if (type === "unknown") {
		return {
			isValid: false,
			type: "unknown",
			error:
				"Enter a valid path (e.g., ~/projects/app) or git URL (e.g., github.com/org/repo)",
		};
	}

	if (type === "github") {
		const match = input.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
		if (!match) {
			return {
				isValid: false,
				type: "github",
				error: "Invalid GitHub URL. Use format: github.com/org/repo",
			};
		}
		return { isValid: true, type: "github" };
	}

	if (type === "git") {
		if (!input.match(/[\w-]+\/[\w.-]+/) && !input.match(/\.git$/)) {
			return {
				isValid: false,
				type: "git",
				error: "Invalid git URL format",
			};
		}
		return { isValid: true, type: "git" };
	}

	if (type === "local") {
		if (input.length < 2) {
			return {
				isValid: false,
				type: "local",
				error: "Path too short",
			};
		}
		return { isValid: true, type: "local" };
	}

	return { isValid: false, type: "unknown" };
}

function getInputIcon(type: InputType, className?: string) {
	switch (type) {
		case "github":
			return <Github className={className} />;
		case "git":
			return <GitBranch className={cn(className, "text-orange-500")} />;
		case "local":
			return <HardDrive className={cn(className, "text-blue-500")} />;
		default:
			return <HardDrive className={cn(className, "text-muted-foreground")} />;
	}
}

interface AddWorkspaceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdd: (workspace: CreateWorkspaceRequest) => void;
}

export function AddWorkspaceDialog({
	open,
	onOpenChange,
	onAdd,
}: AddWorkspaceDialogProps) {
	const [input, setInput] = React.useState("");
	const [showSuggestions, setShowSuggestions] = React.useState(false);
	const [selectedIndex, setSelectedIndex] = React.useState(-1);
	const inputRef = React.useRef<HTMLInputElement>(null);

	const validation = validateInput(input);
	const inputType = detectInputType(input);

	const { suggestions: apiSuggestions } = useSuggestions(input);

	const suggestions = React.useMemo(() => {
		return apiSuggestions.map((s) => s.value).slice(0, 6);
	}, [apiSuggestions]);

	React.useEffect(() => {
		setSelectedIndex(-1);
	}, []);

	const handleSubmit = () => {
		if (!validation.isValid) return;

		const sourceType = inputType === "local" ? "local" : "git";
		onAdd({
			path: input.trim(),
			sourceType,
		});

		setInput("");
		onOpenChange(false);
	};

	const handleSuggestionClick = (suggestion: string) => {
		setInput(suggestion);
		setShowSuggestions(false);
		setSelectedIndex(-1);
		inputRef.current?.focus();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (!showSuggestions || suggestions.length === 0) {
			if (e.key === "Enter" && validation.isValid) {
				handleSubmit();
			}
			return;
		}

		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setSelectedIndex((prev) =>
					prev < suggestions.length - 1 ? prev + 1 : prev,
				);
				break;
			case "ArrowUp":
				e.preventDefault();
				setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
				break;
			case "Enter":
				e.preventDefault();
				if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
					handleSuggestionClick(suggestions[selectedIndex]);
				} else if (validation.isValid) {
					handleSubmit();
				}
				break;
			case "Escape":
				setShowSuggestions(false);
				setSelectedIndex(-1);
				break;
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add Workspace</DialogTitle>
				</DialogHeader>
				<div className="space-y-4 py-4">
					<div className="relative">
						<div className="flex items-center gap-2">
							<div className="shrink-0 w-8 h-8 flex items-center justify-center rounded-md border bg-muted">
								{getInputIcon(inputType, "h-4 w-4")}
							</div>
							<div className="flex-1 relative">
								<Input
									ref={inputRef}
									value={input}
									onChange={(e) => setInput(e.target.value)}
									onFocus={() => setShowSuggestions(true)}
									onBlur={() =>
										setTimeout(() => setShowSuggestions(false), 150)
									}
									placeholder="~/projects/app or github.com/org/repo"
									className={cn(
										"font-mono text-sm",
										validation.error &&
											input.trim() &&
											"border-destructive focus-visible:ring-destructive",
									)}
									onKeyDown={handleKeyDown}
								/>
								{showSuggestions && suggestions.length > 0 && (
									<div className="absolute z-50 top-full left-0 right-0 mt-1 bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
										{suggestions.map((suggestion, index) => {
											const suggestionType = detectInputType(suggestion);
											return (
												<button
													type="button"
													key={suggestion}
													className={cn(
														"w-full flex items-center gap-2 px-3 py-2 text-sm font-mono hover:bg-accent text-left",
														index === selectedIndex && "bg-accent",
													)}
													onMouseDown={() => handleSuggestionClick(suggestion)}
													onMouseEnter={() => setSelectedIndex(index)}
												>
													{getInputIcon(suggestionType, "h-3.5 w-3.5 shrink-0")}
													<span className="truncate">{suggestion}</span>
												</button>
											);
										})}
									</div>
								)}
							</div>
						</div>
						<div className="mt-3 h-5 flex items-center">
							{input.trim() && (
								<div className="flex items-center gap-1.5 text-xs">
									{validation.isValid ? (
										<>
											<Check className="h-3.5 w-3.5 text-green-500" />
											<span className="text-muted-foreground">
												{inputType === "github" && "GitHub repository"}
												{inputType === "git" && "Git repository"}
												{inputType === "local" && "Local folder"}
											</span>
										</>
									) : (
										<>
											<AlertCircle className="h-3.5 w-3.5 text-destructive" />
											<span className="text-destructive">
												{validation.error}
											</span>
										</>
									)}
								</div>
							)}
						</div>
					</div>
					<div className="text-xs text-muted-foreground space-y-1">
						<p className="font-medium">Supported formats:</p>
						<ul className="list-disc list-inside space-y-0.5 pl-1">
							<li>Local paths: ~/projects/app, /var/www/site</li>
							<li>GitHub: github.com/org/repo, git@github.com:org/repo</li>
							<li>
								Git: https://gitlab.com/org/repo, git@bitbucket.org:org/repo
							</li>
						</ul>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={!validation.isValid}>
						Add Workspace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
