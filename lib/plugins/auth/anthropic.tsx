"use client";

import { ExternalLink, Key, Loader2, LogIn } from "lucide-react";
import * as React from "react";
import { mutate } from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import type {
	AuthPlugin,
	OAuthCompleteResult,
	OAuthOption,
	OAuthStartResult,
} from "./types";

/**
 * Anthropic OAuth authentication plugin
 *
 * Supports two OAuth modes:
 * - "max": Claude Pro/Max account login via claude.ai
 * - "console": API key creation via console.anthropic.com
 */

const OAUTH_OPTIONS: OAuthOption[] = [
	{
		id: "max",
		label: "Claude Pro/Max Account",
		description: "Sign in with your Claude subscription",
		icon: "login",
	},
	{
		id: "console",
		label: "Create API Key (Console)",
		description: "Generate an API key from Anthropic Console",
		icon: "key",
	},
];

async function startOAuth(optionId: string): Promise<OAuthStartResult> {
	const mode = optionId === "console" ? "console" : "max";
	const result = await api.anthropicAuthorize(mode);
	return {
		url: result.url,
		verifier: result.verifier,
	};
}

async function completeOAuth(
	code: string,
	verifier: string,
): Promise<OAuthCompleteResult> {
	const result = await api.anthropicExchange({ code, verifier });
	if (result.success) {
		// Refresh credentials list after successful OAuth
		mutate("credentials");
	}
	return {
		success: result.success,
		error: result.error,
	};
}

/**
 * Anthropic auth plugin implementation
 */
export const anthropicAuthPlugin: AuthPlugin = {
	providerId: "anthropic",
	label: "Claude Login",
	oauthOptions: OAUTH_OPTIONS,
	startOAuth,
	completeOAuth,
};

/**
 * Provider logo component helper
 */
function ProviderLogo({ className }: { className?: string }) {
	const [hasError, setHasError] = React.useState(false);

	if (hasError) {
		return <Key className={className} />;
	}

	return (
		<img
			src="/data/models-dev/logos/anthropic.svg"
			alt=""
			className={`${className} dark:invert`}
			style={{ objectFit: "contain" }}
			onError={() => setHasError(true)}
		/>
	);
}

/**
 * Props for the Anthropic OAuth flow component
 */
interface AnthropicOAuthFlowProps {
	onComplete: () => void;
	onCancel: () => void;
}

/**
 * Anthropic OAuth flow UI component
 *
 * Two-step flow:
 * 1. User selects auth mode (max vs console)
 * 2. User pastes authorization code after authenticating in browser
 */
export function AnthropicOAuthFlow({
	onComplete,
	onCancel,
}: AnthropicOAuthFlowProps) {
	const [step, setStep] = React.useState<"start" | "code">("start");
	const [authUrl, setAuthUrl] = React.useState<string | null>(null);
	const [verifier, setVerifier] = React.useState<string | null>(null);
	const [code, setCode] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const handleStartOAuth = async (optionId: string) => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await anthropicAuthPlugin.startOAuth(optionId);
			setAuthUrl(result.url);
			setVerifier(result.verifier);
			setStep("code");
			// Open auth URL in new tab
			window.open(result.url, "_blank");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start OAuth");
		} finally {
			setIsLoading(false);
		}
	};

	const handleSubmitCode = async () => {
		if (!code.trim() || !verifier) return;

		setIsLoading(true);
		setError(null);
		try {
			const result = await anthropicAuthPlugin.completeOAuth(
				code.trim(),
				verifier,
			);
			if (result.success) {
				onComplete();
			} else {
				setError(result.error || "Failed to exchange code");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to exchange code");
		} finally {
			setIsLoading(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && code.trim()) {
			handleSubmitCode();
		} else if (e.key === "Escape") {
			onCancel();
		}
	};

	if (step === "start") {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3 pb-3 border-b">
					<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
						<ProviderLogo className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">Anthropic</div>
						<div className="text-xs text-muted-foreground">
							Sign in with your Claude account
						</div>
					</div>
				</div>

				<p className="text-sm text-muted-foreground">
					Choose how you want to authenticate:
				</p>

				<div className="space-y-2">
					{OAUTH_OPTIONS.map((option) => (
						<Button
							key={option.id}
							variant="outline"
							className="w-full justify-start gap-2"
							onClick={() => handleStartOAuth(option.id)}
							disabled={isLoading}
						>
							{option.icon === "login" ? (
								<LogIn className="h-4 w-4" />
							) : (
								<Key className="h-4 w-4" />
							)}
							{option.label}
						</Button>
					))}
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}

				<div className="flex justify-end">
					<Button variant="ghost" size="sm" onClick={onCancel}>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-3 pb-3 border-b">
				<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
					<ProviderLogo className="h-5 w-5" />
				</div>
				<div>
					<div className="font-medium">Anthropic</div>
					<div className="text-xs text-muted-foreground">
						Paste the authorization code
					</div>
				</div>
			</div>

			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					A new tab should have opened. Sign in and copy the authorization code
					shown after authentication.
				</p>

				{authUrl && (
					<Button
						variant="outline"
						size="sm"
						className="gap-2"
						onClick={() => window.open(authUrl, "_blank")}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						Open Auth Page Again
					</Button>
				)}

				<div className="space-y-2">
					<Label className="text-sm">Authorization Code</Label>
					<Input
						value={code}
						onChange={(e) => setCode(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Paste the code here..."
						className="font-mono text-sm"
						disabled={isLoading}
					/>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}
			</div>

			<div className="flex justify-end gap-2">
				<Button variant="outline" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					size="sm"
					onClick={handleSubmitCode}
					disabled={!code.trim() || isLoading}
				>
					{isLoading ? (
						<>
							<Loader2 className="h-4 w-4 mr-2 animate-spin" />
							Verifying...
						</>
					) : (
						"Complete"
					)}
				</Button>
			</div>
		</div>
	);
}

export default anthropicAuthPlugin;
