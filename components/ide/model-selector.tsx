import { Brain, ChevronDown } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentModel } from "@/lib/api-types";

interface ModelSelectorProps {
	models: AgentModel[];
	selectedModelId: string | null; // Can be "modelId", "modelId:thinking", or null
	onSelectModel: (modelId: string | null) => void;
	disabled?: boolean;
	label?: string;
	/** Compact mode for chat input (no label, icon button) */
	compact?: boolean;
}

// Model variant represents a specific model + reasoning mode combination
interface ModelVariant {
	id: string; // "modelId" or "modelId:thinking"
	displayName: string; // "Model Name" or "Model Name (thinking)"
	model: AgentModel;
	reasoning: boolean; // Whether thinking is enabled for this variant
}

// Helper to extract version number from model name for sorting
export function extractVersion(name: string): number {
	// Match patterns like "3", "3.5", "4", "4.5", "4.6" etc.
	// Look for the last occurrence of a version number to handle cases like "GPT-4 Turbo"
	const matches = name.match(/(\d+(?:\.\d+)?)/g);
	if (!matches || matches.length === 0) return 0;

	// Use the last number found (handles "Claude 3.5" better than first match)
	return parseFloat(matches[matches.length - 1]);
}

// Helper to get base model name without version or (latest) suffix
export function getBaseName(name: string): string {
	// Remove (latest), (thinking), version numbers, and v2/v3 suffixes
	return name
		.replace(/\s*\(latest\)\s*/gi, "")
		.replace(/\s*\(thinking\)\s*/gi, "")
		.replace(/\s+v\d+\s*/gi, "") // Remove v2, v3, etc.
		.replace(/\s+[\d.]+\s*$/, "") // Remove trailing version numbers
		.trim();
}

// Deduplicate models: prefer "latest" IDs but show clean display names
export function deduplicateModels(models: AgentModel[]): AgentModel[] {
	const modelMap = new Map<string, AgentModel>();

	for (const model of models) {
		// Remove " (latest)" from display name for deduplication key
		const cleanName = model.name.replace(/\s*\(latest\)\s*/gi, "").trim();
		const isLatest = /\(latest\)/i.test(model.name);

		const existing = modelMap.get(cleanName);
		if (!existing) {
			// First time seeing this model name
			modelMap.set(cleanName, {
				...model,
				name: cleanName, // Use clean name for display
			});
		} else {
			// We have a duplicate - prefer the one marked as "(latest)" in the original name
			if (isLatest) {
				modelMap.set(cleanName, {
					...model,
					name: cleanName, // Use clean name for display
				});
			}
		}
	}

	return Array.from(modelMap.values());
}

// Create model variants (with/without thinking for reasoning models)
export function createModelVariants(models: AgentModel[]): ModelVariant[] {
	const variants: ModelVariant[] = [];

	for (const model of models) {
		if (model.reasoning) {
			// For reasoning-capable models, create both variants
			// Thinking variant first (default preference)
			variants.push({
				id: `${model.id}:thinking`,
				displayName: `${model.name} (thinking)`,
				model,
				reasoning: true,
			});
			variants.push({
				id: model.id,
				displayName: model.name,
				model,
				reasoning: false,
			});
		} else {
			// For non-reasoning models, just one variant
			variants.push({
				id: model.id,
				displayName: model.name,
				model,
				reasoning: false,
			});
		}
	}

	return variants;
}

// Sort model variants by base name, version (descending), and reasoning
export function sortModelVariants(variants: ModelVariant[]): ModelVariant[] {
	return [...variants].sort((a, b) => {
		const baseA = getBaseName(a.displayName);
		const baseB = getBaseName(b.displayName);

		// First sort by base model name (e.g., "Claude Haiku" vs "Claude Sonnet")
		const baseCompare = baseA.localeCompare(baseB);
		if (baseCompare !== 0) return baseCompare;

		// Then sort by version (descending - higher versions first)
		const versionA = extractVersion(a.displayName);
		const versionB = extractVersion(b.displayName);
		if (versionA !== versionB) return versionB - versionA;

		// Finally, thinking variants come before non-thinking for same model
		if (a.reasoning && !b.reasoning) return -1;
		if (!a.reasoning && b.reasoning) return 1;

		// Fall back to alphabetical if all else is equal
		return a.displayName.localeCompare(b.displayName);
	});
}

export function ModelSelector({
	models,
	selectedModelId,
	onSelectModel,
	disabled = false,
	label = "Model:",
	compact = false,
}: ModelSelectorProps) {
	// Deduplicate models and create variants
	const modelVariants = React.useMemo(() => {
		const deduplicated = deduplicateModels(models);
		return createModelVariants(deduplicated);
	}, [models]);

	// Group variants by provider and sort them
	const variantsByProvider = React.useMemo(() => {
		const grouped = modelVariants.reduce(
			(acc, variant) => {
				const provider = variant.model.provider || "Other";
				if (!acc[provider]) {
					acc[provider] = [];
				}
				acc[provider].push(variant);
				return acc;
			},
			{} as Record<string, ModelVariant[]>,
		);

		// Sort variants within each provider
		for (const provider in grouped) {
			grouped[provider] = sortModelVariants(grouped[provider]);
		}

		return grouped;
	}, [modelVariants]);

	const providerEntries = Object.entries(variantsByProvider);

	// Find selected variant
	const selectedVariant = modelVariants.find((v) => v.id === selectedModelId);

	return (
		<div className="flex items-center gap-2">
			{!compact && label && (
				<span className="text-sm text-muted-foreground w-20 text-right">
					{label}
				</span>
			)}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size={compact ? "sm" : "sm"}
						className={
							compact
								? "h-8 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
								: "gap-2 min-w-[200px] justify-between"
						}
						disabled={disabled || models.length === 0}
						title={
							compact
								? selectedVariant
									? `Model: ${selectedVariant.displayName}`
									: "Select model"
								: undefined
						}
					>
						{compact ? (
							<>
								<span className="truncate max-w-[120px]">
									{selectedVariant
										? selectedVariant.displayName.replace(
												/\s*\(thinking\)\s*/i,
												"",
											)
										: "Default model"}
								</span>
								{selectedVariant?.reasoning && (
									<Brain className="h-3 w-3 shrink-0 ml-1" />
								)}
							</>
						) : selectedVariant ? (
							<>
								<span className="truncate">{selectedVariant.displayName}</span>
								<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
							</>
						) : (
							<>
								<span className="text-muted-foreground">
									{models.length === 0
										? "No models available"
										: "Default model"}
								</span>
								<ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
							</>
						)}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="center"
					className="w-[300px] max-h-[400px] overflow-y-auto"
				>
					{/* Default option */}
					<DropdownMenuItem onClick={() => onSelectModel(null)}>
						<span>Default model</span>
					</DropdownMenuItem>

					{providerEntries.length > 0 && <DropdownMenuSeparator />}

					{/* Model variants grouped by provider */}
					{providerEntries.map(([provider, providerVariants], idx) => (
						<div key={provider}>
							{idx > 0 && <DropdownMenuSeparator />}
							<div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
								{provider}
							</div>
							{providerVariants.map((variant) => (
								<DropdownMenuItem
									key={variant.id}
									onClick={() => onSelectModel(variant.id)}
									className="flex flex-col items-start gap-0.5 pl-6"
								>
									<span className="font-medium">{variant.displayName}</span>
									{variant.model.description && !variant.reasoning && (
										<span className="text-xs text-muted-foreground">
											{variant.model.description}
										</span>
									)}
								</DropdownMenuItem>
							))}
						</div>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
