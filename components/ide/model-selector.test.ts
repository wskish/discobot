import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentModel } from "@/lib/api-types";
import {
	createModelVariants,
	deduplicateModels,
	extractVersion,
	getBaseName,
	sortModelVariants,
} from "./model-selector";

describe("extractVersion", () => {
	it("should extract simple version numbers", () => {
		assert.equal(extractVersion("Claude 3"), 3);
		assert.equal(extractVersion("Claude 4"), 4);
		assert.equal(extractVersion("GPT-4"), 4);
	});

	it("should extract decimal version numbers", () => {
		assert.equal(extractVersion("Claude 3.5"), 3.5);
		assert.equal(extractVersion("Claude 4.5"), 4.5);
		assert.equal(extractVersion("Claude Haiku 4.6"), 4.6);
	});

	it("should handle multiple numbers by taking the last one", () => {
		assert.equal(extractVersion("GPT-4 Turbo"), 4);
		assert.equal(extractVersion("Claude 3 Opus"), 3);
		assert.equal(extractVersion("Model 2.5 v3"), 3);
	});

	it("should return 0 for models without version numbers", () => {
		assert.equal(extractVersion("DeepSeek"), 0);
		assert.equal(extractVersion("Gemini Flash"), 0);
		assert.equal(extractVersion("No Numbers Here"), 0);
	});

	it("should handle version numbers with (latest) suffix", () => {
		assert.equal(extractVersion("Claude 4.5 (latest)"), 4.5);
		assert.equal(extractVersion("GPT-3.5 (latest)"), 3.5);
	});

	it("should handle version numbers with (thinking) suffix", () => {
		assert.equal(extractVersion("Claude 4.5 (thinking)"), 4.5);
	});
});

describe("getBaseName", () => {
	it("should remove version numbers", () => {
		assert.equal(getBaseName("Claude Haiku 3.5"), "Claude Haiku");
		assert.equal(getBaseName("Claude Opus 4"), "Claude Opus");
		assert.equal(getBaseName("GPT-4"), "GPT-4"); // Hyphenated, not trailing
	});

	it("should remove (latest) suffix", () => {
		assert.equal(getBaseName("Claude 4.5 (latest)"), "Claude");
		assert.equal(getBaseName("Model Name (latest)"), "Model Name");
	});

	it("should remove (thinking) suffix", () => {
		assert.equal(getBaseName("Claude 4.5 (thinking)"), "Claude");
		assert.equal(getBaseName("Model (thinking)"), "Model");
	});

	it("should remove v2/v3 suffixes", () => {
		assert.equal(getBaseName("Claude Sonnet 3.5 v2"), "Claude Sonnet");
		assert.equal(getBaseName("Model v3"), "Model");
	});

	it("should handle models without version numbers", () => {
		assert.equal(getBaseName("DeepSeek"), "DeepSeek");
		assert.equal(getBaseName("Gemini Flash"), "Gemini Flash");
	});

	it("should handle complex cases", () => {
		assert.equal(
			getBaseName("Claude Haiku 4.5 (latest) (thinking)"),
			"Claude Haiku",
		);
		assert.equal(getBaseName("Model 2.5 v3 (latest)"), "Model");
	});
});

describe("deduplicateModels", () => {
	it("should keep single models as-is", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
		];

		const result = deduplicateModels(models);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "anthropic:claude-haiku-4-5");
		assert.equal(result[0].name, "Claude Haiku 4.5");
	});

	it("should deduplicate models with (latest) suffix", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-haiku-4-5-20251001",
				name: "Claude Haiku 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:claude-haiku-4-5",
				name: "Claude Haiku 4.5 (latest)",
				provider: "Anthropic",
				reasoning: true,
			},
		];

		const result = deduplicateModels(models);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "anthropic:claude-haiku-4-5"); // Prefer latest ID
		assert.equal(result[0].name, "Claude Haiku 4.5"); // Clean name
	});

	it("should prefer latest variant when it comes first", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-opus-4-5",
				name: "Claude Opus 4.5 (latest)",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:claude-opus-4-5-20251101",
				name: "Claude Opus 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
		];

		const result = deduplicateModels(models);
		assert.equal(result.length, 1);
		assert.equal(result[0].id, "anthropic:claude-opus-4-5");
		assert.equal(result[0].name, "Claude Opus 4.5");
	});

	it("should keep different models separate", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-haiku-4-5",
				name: "Claude Haiku 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
		];

		const result = deduplicateModels(models);
		assert.equal(result.length, 2);
	});

	it("should handle models from different providers", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-3-5",
				name: "Claude 3.5",
				provider: "Anthropic",
				reasoning: false,
			},
			{
				id: "openai:gpt-4",
				name: "GPT-4",
				provider: "OpenAI",
				reasoning: false,
			},
		];

		const result = deduplicateModels(models);
		assert.equal(result.length, 2);
	});
});

describe("createModelVariants", () => {
	it("should create thinking and non-thinking variants for reasoning models", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-sonnet-4-5",
				name: "Claude Sonnet 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(variants.length, 2);
		assert.equal(variants[0].id, "anthropic:claude-sonnet-4-5:thinking");
		assert.equal(variants[0].displayName, "Claude Sonnet 4.5 (thinking)");
		assert.equal(variants[0].reasoning, true);
		assert.equal(variants[1].id, "anthropic:claude-sonnet-4-5");
		assert.equal(variants[1].displayName, "Claude Sonnet 4.5");
		assert.equal(variants[1].reasoning, false);
	});

	it("should create single variant for non-reasoning models", () => {
		const models: AgentModel[] = [
			{
				id: "openai:gpt-4",
				name: "GPT-4",
				provider: "OpenAI",
				reasoning: false,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(variants.length, 1);
		assert.equal(variants[0].id, "openai:gpt-4");
		assert.equal(variants[0].displayName, "GPT-4");
		assert.equal(variants[0].reasoning, false);
	});

	it("should handle mixed reasoning and non-reasoning models", () => {
		const models: AgentModel[] = [
			{
				id: "anthropic:claude-4-5",
				name: "Claude 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "openai:gpt-4",
				name: "GPT-4",
				provider: "OpenAI",
				reasoning: false,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(variants.length, 3); // 2 for Claude + 1 for GPT-4
	});
});

describe("sortModelVariants", () => {
	it("should sort by base name alphabetically", () => {
		const variants = createModelVariants([
			{
				id: "anthropic:sonnet",
				name: "Claude Sonnet 3",
				provider: "Anthropic",
				reasoning: false,
			},
			{
				id: "anthropic:haiku",
				name: "Claude Haiku 3",
				provider: "Anthropic",
				reasoning: false,
			},
		]);

		const sorted = sortModelVariants(variants);
		assert.equal(sorted[0].displayName, "Claude Haiku 3");
		assert.equal(sorted[1].displayName, "Claude Sonnet 3");
	});

	it("should sort by version descending within same base name", () => {
		const variants = createModelVariants([
			{
				id: "anthropic:haiku-3",
				name: "Claude Haiku 3",
				provider: "Anthropic",
				reasoning: false,
			},
			{
				id: "anthropic:haiku-4-5",
				name: "Claude Haiku 4.5",
				provider: "Anthropic",
				reasoning: false,
			},
			{
				id: "anthropic:haiku-3-5",
				name: "Claude Haiku 3.5",
				provider: "Anthropic",
				reasoning: false,
			},
		]);

		const sorted = sortModelVariants(variants);
		assert.equal(sorted[0].displayName, "Claude Haiku 4.5");
		assert.equal(sorted[1].displayName, "Claude Haiku 3.5");
		assert.equal(sorted[2].displayName, "Claude Haiku 3");
	});

	it("should sort thinking variants before non-thinking", () => {
		const variants = createModelVariants([
			{
				id: "anthropic:claude-4-5",
				name: "Claude 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
		]);

		const sorted = sortModelVariants(variants);
		assert.equal(sorted[0].displayName, "Claude 4.5 (thinking)");
		assert.equal(sorted[0].reasoning, true);
		assert.equal(sorted[1].displayName, "Claude 4.5");
		assert.equal(sorted[1].reasoning, false);
	});

	it("should handle models without version numbers", () => {
		const variants = createModelVariants([
			{
				id: "deepseek:model",
				name: "DeepSeek",
				provider: "DeepSeek",
				reasoning: false,
			},
			{
				id: "anthropic:claude-4",
				name: "Claude 4",
				provider: "Anthropic",
				reasoning: false,
			},
		]);

		const sorted = sortModelVariants(variants);
		// Both should be sorted alphabetically by base name
		assert.equal(sorted[0].displayName, "Claude 4");
		assert.equal(sorted[1].displayName, "DeepSeek");
	});

	it("should handle complex real-world scenario", () => {
		const variants = createModelVariants([
			{
				id: "anthropic:opus-3",
				name: "Claude Opus 3",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:haiku-4-5",
				name: "Claude Haiku 4.5",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:sonnet-3-5",
				name: "Claude Sonnet 3.5",
				provider: "Anthropic",
				reasoning: true,
			},
			{
				id: "anthropic:haiku-3",
				name: "Claude Haiku 3",
				provider: "Anthropic",
				reasoning: false,
			},
		]);

		const sorted = sortModelVariants(variants);

		// Expected order:
		// Claude Haiku 4.5 (thinking)
		// Claude Haiku 4.5
		// Claude Haiku 3
		// Claude Opus 3 (thinking)
		// Claude Opus 3
		// Claude Sonnet 3.5 (thinking)
		// Claude Sonnet 3.5

		assert.equal(sorted[0].displayName, "Claude Haiku 4.5 (thinking)");
		assert.equal(sorted[1].displayName, "Claude Haiku 4.5");
		assert.equal(sorted[2].displayName, "Claude Haiku 3");
		assert.equal(sorted[3].displayName, "Claude Opus 3 (thinking)");
		assert.equal(sorted[4].displayName, "Claude Opus 3");
		assert.equal(sorted[5].displayName, "Claude Sonnet 3.5 (thinking)");
		assert.equal(sorted[6].displayName, "Claude Sonnet 3.5");
	});
});

describe("Edge cases and fallback behavior", () => {
	it("should handle empty model list", () => {
		const models: AgentModel[] = [];
		const deduplicated = deduplicateModels(models);
		const variants = createModelVariants(deduplicated);
		const sorted = sortModelVariants(variants);

		assert.equal(deduplicated.length, 0);
		assert.equal(variants.length, 0);
		assert.equal(sorted.length, 0);
	});

	it("should handle models with special characters", () => {
		const models: AgentModel[] = [
			{
				id: "provider:model-with-dashes",
				name: "Model-With-Dashes 2.0",
				provider: "Provider",
				reasoning: false,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(variants.length, 1);
		assert.equal(extractVersion(variants[0].displayName), 2.0);
	});

	it("should handle models with unusual spacing", () => {
		const models: AgentModel[] = [
			{
				id: "provider:model",
				name: "  Model  3.5  (latest)  ",
				provider: "Provider",
				reasoning: false,
			},
		];

		const deduplicated = deduplicateModels(models);
		assert.equal(deduplicated[0].name, "Model  3.5"); // Cleaned
	});

	it("should handle models without provider", () => {
		const models: AgentModel[] = [
			{
				id: "model:id",
				name: "Unknown Model",
				reasoning: false,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(variants.length, 1);
		assert.equal(variants[0].model.provider, undefined);
	});

	it("should handle models with very long version numbers", () => {
		const version = extractVersion("Model 123.456.789");
		assert.equal(version, 789); // Takes last number
	});

	it("should handle models with version in middle of name", () => {
		const models: AgentModel[] = [
			{
				id: "provider:model",
				name: "GPT 4 Turbo",
				provider: "OpenAI",
				reasoning: false,
			},
		];

		const variants = createModelVariants(models);
		assert.equal(extractVersion(variants[0].displayName), 4);
	});
});
