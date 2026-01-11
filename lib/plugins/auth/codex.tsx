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
 * Codex (ChatGPT) OAuth authentication plugin
 *
 * Uses OpenAI's PKCE OAuth flow:
 * 1. Generate PKCE verifier and challenge
 * 2. Redirect user to OpenAI authorization page
 * 3. User authenticates with ChatGPT account
 * 4. User copies authorization code from redirect URL
 * 5. Exchange code for tokens
 *
 * This enables access to ChatGPT's Codex API with a Pro/Plus subscription.
 */

const OAUTH_OPTIONS: OAuthOption[] = [
	{
		id: "chatgpt",
		label: "ChatGPT Pro/Plus",
		description: "Sign in with your ChatGPT subscription",
		icon: "login",
	},
];

async function startOAuth(_optionId: string): Promise<OAuthStartResult> {
	const result = await api.codexAuthorize();
	return {
		url: result.url,
		verifier: result.verifier,
	};
}

async function completeOAuth(
	code: string,
	verifier: string,
): Promise<OAuthCompleteResult> {
	const result = await api.codexExchange({ code, verifier });
	if (result.success) {
		mutate("credentials");
	}
	return {
		success: result.success,
		error: result.error,
	};
}

/**
 * Codex auth plugin implementation
 */
export const codexAuthPlugin: AuthPlugin = {
	providerId: "codex",
	label: "ChatGPT Login",
	oauthOptions: OAUTH_OPTIONS,
	startOAuth,
	completeOAuth,
};

/**
 * Provider logo component
 */
function ProviderLogo({ className }: { className?: string }) {
	const [hasError, setHasError] = React.useState(false);

	if (hasError) {
		return <Key className={className} />;
	}

	return (
		<img
			src="/data/models-dev/logos/openai.svg"
			alt=""
			className={`${className} dark:invert`}
			style={{ objectFit: "contain" }}
			onError={() => setHasError(true)}
		/>
	);
}

/**
 * Props for the Codex OAuth flow component
 */
interface CodexOAuthFlowProps {
	onComplete: () => void;
	onCancel: () => void;
}

/**
 * Codex OAuth flow UI component
 *
 * Two-step flow:
 * 1. User clicks to start auth, browser opens to OpenAI
 * 2. After auth, user copies code from redirect URL and pastes it
 */
export function CodexOAuthFlow({ onComplete, onCancel }: CodexOAuthFlowProps) {
	const [step, setStep] = React.useState<"start" | "code">("start");
	const [authUrl, setAuthUrl] = React.useState<string | null>(null);
	const [verifier, setVerifier] = React.useState<string | null>(null);
	const [code, setCode] = React.useState("");
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const handleStartOAuth = async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await codexAuthPlugin.startOAuth("chatgpt");
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
			// Extract code from URL if user pasted full URL
			let authCode = code.trim();
			if (authCode.includes("code=")) {
				const url = new URL(authCode);
				authCode = url.searchParams.get("code") || authCode;
			}

			const result = await codexAuthPlugin.completeOAuth(authCode, verifier);
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
						<div className="font-medium">Codex (ChatGPT)</div>
						<div className="text-xs text-muted-foreground">
							Sign in with your ChatGPT account
						</div>
					</div>
				</div>

				<p className="text-sm text-muted-foreground">
					Connect your ChatGPT Pro or Plus subscription to use Codex models.
				</p>

				<Button
					variant="outline"
					className="w-full justify-start gap-2"
					onClick={handleStartOAuth}
					disabled={isLoading}
				>
					{isLoading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<LogIn className="h-4 w-4" />
					)}
					Sign in with ChatGPT
				</Button>

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
					<div className="font-medium">Codex (ChatGPT)</div>
					<div className="text-xs text-muted-foreground">
						Paste the authorization code
					</div>
				</div>
			</div>

			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					After signing in, you'll be redirected to a page that may show an
					error. Copy the <strong>code</strong> parameter from the URL and paste
					it below.
				</p>

				<div className="bg-muted/50 rounded-lg p-3 text-xs font-mono text-muted-foreground break-all">
					http://localhost:1455/auth/callback?<strong>code=abc123...</strong>
					&state=xyz
				</div>

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
					<Label className="text-sm">Authorization Code or Full URL</Label>
					<Input
						value={code}
						onChange={(e) => setCode(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Paste the code or full URL here..."
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

export default codexAuthPlugin;
