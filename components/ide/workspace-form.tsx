import { SiGithub } from "@icons-pack/react-simple-icons";
import {
	AlertCircle,
	Check,
	Container,
	GitBranch,
	HardDrive,
	Zap,
} from "lucide-react";
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { CreateWorkspaceRequest } from "@/lib/api-types";
import { useSuggestions } from "@/lib/hooks/use-suggestions";
import { cn } from "@/lib/utils";

type InputType = "unknown" | "local" | "git" | "github";

interface ValidationResult {
	isValid: boolean;
	type: InputType;
	error?: string;
}

// Hoisted regex patterns to avoid recreation on every call
const RE_GITHUB_URL = /^(https?:\/\/)?(www\.)?github\.com\//;
const RE_GITHUB_SSH = /^git@github\.com:/;
const RE_GITHUB_SHORT = /^github\.com\//;
const RE_GIT_PROTOCOL = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/;
const RE_GIT_SUFFIX = /\.git$/;
const RE_GIT_SSH_HOST = /^[a-z]+@[a-z0-9.-]+:/;
const RE_WINDOWS_PATH = /^[A-Z]:\\/;
const RE_PARENT_PATH = /^\.\.\//;
const RE_ORG_REPO = /^[a-zA-Z0-9][\w.-]*\/[\w.-]+$/;
const RE_GITHUB_EXTRACT = /github\.com[/:]([\w-]+)\/([\w.-]+)/;
const RE_REPO_PATH = /[\w-]+\/[\w.-]+/;

function detectInputType(input: string): InputType {
	if (!input.trim()) return "unknown";

	const trimmed = input.trim();

	if (
		RE_GITHUB_URL.test(trimmed) ||
		RE_GITHUB_SSH.test(trimmed) ||
		RE_GITHUB_SHORT.test(trimmed)
	) {
		return "github";
	}

	if (
		RE_GIT_PROTOCOL.test(trimmed) ||
		RE_GIT_SUFFIX.test(trimmed) ||
		RE_GIT_SSH_HOST.test(trimmed)
	) {
		return "git";
	}

	if (
		trimmed.startsWith("~") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("./") ||
		RE_WINDOWS_PATH.test(trimmed) ||
		RE_PARENT_PATH.test(trimmed)
	) {
		return "local";
	}

	// Detect org/repo shorthand (e.g., "facebook/react", "vercel/next.js")
	// Must start with alphanumeric, contain exactly one slash, no special prefixes
	if (RE_ORG_REPO.test(trimmed)) {
		return "github";
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
		// Check for org/repo shorthand first
		if (RE_ORG_REPO.test(input.trim())) {
			return { isValid: true, type: "github" };
		}
		// Then check for full GitHub URL
		if (!RE_GITHUB_EXTRACT.test(input)) {
			return {
				isValid: false,
				type: "github",
				error:
					"Invalid GitHub URL. Use format: github.com/org/repo or org/repo",
			};
		}
		return { isValid: true, type: "github" };
	}

	if (type === "git") {
		if (!RE_REPO_PATH.test(input) && !RE_GIT_SUFFIX.test(input)) {
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

function normalizeGitPath(input: string): string {
	const trimmed = input.trim();
	// Convert org/repo shorthand to full GitHub URL
	if (RE_ORG_REPO.test(trimmed)) {
		return `https://github.com/${trimmed}`;
	}
	return trimmed;
}

function getInputIcon(type: InputType, className?: string) {
	switch (type) {
		case "github":
			return <SiGithub className={className} />;
		case "git":
			return <GitBranch className={cn(className, "text-orange-500")} />;
		case "local":
			return <HardDrive className={cn(className, "text-blue-500")} />;
		default:
			return <HardDrive className={cn(className, "text-muted-foreground")} />;
	}
}

export interface WorkspaceFormRef {
	submit: () => void;
	isValid: boolean;
}

interface WorkspaceFormProps {
	onSubmit: (workspace: CreateWorkspaceRequest) => void;
	/** Called when validation state changes */
	onValidationChange?: (isValid: boolean) => void;
	/** Show format hints below the input */
	showFormatHints?: boolean;
	/** Initial value for the input field */
	initialValue?: string;
	className?: string;
}

export const WorkspaceForm = React.forwardRef<
	WorkspaceFormRef,
	WorkspaceFormProps
>(function WorkspaceForm(
	{
		onSubmit,
		onValidationChange,
		showFormatHints = true,
		initialValue,
		className,
	},
	ref,
) {
	const [input, setInput] = React.useState(initialValue ?? "");
	const [provider, setProvider] = React.useState<"docker" | "local">("docker");
	const [showSuggestions, setShowSuggestions] = React.useState(false);
	const [selectedIndex, setSelectedIndex] = React.useState(-1);
	const inputRef = React.useRef<HTMLInputElement>(null);

	const inputType = detectInputType(input);

	// Only fetch suggestions for local paths
	const shouldFetchSuggestions =
		inputType === "local" || inputType === "unknown";
	const { suggestions: apiSuggestions } = useSuggestions(
		shouldFetchSuggestions ? input : "",
		"path",
	);

	const suggestions = React.useMemo(() => {
		return apiSuggestions.slice(0, 6);
	}, [apiSuggestions]);

	// Check if current input matches a suggestion and get its validity
	const matchingSuggestion = React.useMemo(() => {
		if (inputType !== "local") return null;
		return apiSuggestions.find((s) => s.value === input.trim());
	}, [inputType, apiSuggestions, input]);

	// Enhanced validation that checks git repo status for local paths
	const validation = React.useMemo(() => {
		const baseValidation = validateInput(input);

		// If it's a local path and we have a matching suggestion, check if it's valid
		if (
			baseValidation.isValid &&
			baseValidation.type === "local" &&
			matchingSuggestion
		) {
			if (!matchingSuggestion.valid) {
				return {
					isValid: false,
					type: "local" as InputType,
					error: "Directory must contain a .git folder",
				};
			}
		}

		return baseValidation;
	}, [input, matchingSuggestion]);

	React.useEffect(() => {
		setSelectedIndex(-1);
	}, []);

	// Notify parent of validation changes
	React.useEffect(() => {
		onValidationChange?.(validation.isValid);
	}, [validation.isValid, onValidationChange]);

	const handleSubmit = React.useCallback(() => {
		if (!validation.isValid) return;

		const sourceType = inputType === "local" ? "local" : "git";
		const path = sourceType === "git" ? normalizeGitPath(input) : input.trim();
		onSubmit({
			path,
			sourceType,
			provider,
		});

		setInput("");
	}, [validation.isValid, inputType, input, provider, onSubmit]);

	// Expose submit and isValid to parent via ref
	React.useImperativeHandle(
		ref,
		() => ({
			submit: handleSubmit,
			isValid: validation.isValid,
		}),
		[handleSubmit, validation.isValid],
	);

	const handleSuggestionClick = (suggestionValue: string) => {
		setInput(suggestionValue);
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
					handleSuggestionClick(suggestions[selectedIndex].value);
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
		<div className={cn("space-y-4", className)}>
			<div className="relative">
				<Label className="text-sm font-medium mb-2 block">Workspace Path</Label>
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
							onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
							placeholder="~/projects/app or org/repo"
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
									const suggestionType = detectInputType(suggestion.value);
									return (
										<button
											type="button"
											key={suggestion.value}
											className={cn(
												"w-full flex items-center gap-2 px-3 py-2 text-sm font-mono hover:bg-accent text-left",
												index === selectedIndex && "bg-accent",
												!suggestion.valid && "opacity-60",
											)}
											onMouseDown={() =>
												handleSuggestionClick(suggestion.value)
											}
											onMouseEnter={() => setSelectedIndex(index)}
										>
											{getInputIcon(suggestionType, "h-3.5 w-3.5 shrink-0")}
											<span className="truncate">{suggestion.value}</span>
											{suggestion.valid ? (
												<Check className="h-3.5 w-3.5 text-green-500 ml-auto shrink-0" />
											) : (
												<AlertCircle className="h-3.5 w-3.5 text-muted-foreground ml-auto shrink-0" />
											)}
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
									<span className="text-destructive">{validation.error}</span>
								</>
							)}
						</div>
					)}
				</div>
			</div>
			<div className="space-y-3">
				<Label className="text-sm font-medium">Sandbox Provider</Label>
				<RadioGroup
					value={provider}
					onValueChange={(v) => setProvider(v as "docker" | "local")}
				>
					<div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer">
						<RadioGroupItem
							value="docker"
							id="provider-docker"
							className="mt-0.5"
						/>
						<Label htmlFor="provider-docker" className="flex-1 cursor-pointer">
							<div className="flex items-center gap-2 mb-1">
								<Container className="h-4 w-4 text-blue-500" />
								<span className="font-medium">Docker (Recommended)</span>
							</div>
							<p className="text-xs text-muted-foreground">
								Run agent in isolated container with full Docker support. Safer
								and more compatible.
							</p>
						</Label>
					</div>
					<div className="flex items-start space-x-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer">
						<RadioGroupItem
							value="local"
							id="provider-local"
							className="mt-0.5"
						/>
						<Label htmlFor="provider-local" className="flex-1 cursor-pointer">
							<div className="flex items-center gap-2 mb-1">
								<Zap className="h-4 w-4 text-amber-500" />
								<span className="font-medium">Local Process</span>
							</div>
							<p className="text-xs text-muted-foreground">
								Run agent directly in workspace directory without containers.
								Faster startup but no isolation.
							</p>
						</Label>
					</div>
				</RadioGroup>
			</div>

			{showFormatHints && (
				<div className="text-xs text-muted-foreground space-y-1">
					<p className="font-medium">Supported formats:</p>
					<ul className="list-disc list-inside space-y-0.5 pl-1">
						<li>Local paths: ~/projects/app, /var/www/site</li>
						<li>
							GitHub: org/repo, github.com/org/repo, git@github.com:org/repo
						</li>
						<li>
							Git: https://gitlab.com/org/repo, git@bitbucket.org:org/repo
						</li>
					</ul>
				</div>
			)}
		</div>
	);
});
