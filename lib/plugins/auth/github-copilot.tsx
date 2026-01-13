"use client";

import { Copy, ExternalLink, Key, Loader2, LogIn, Server } from "lucide-react";
import Image from "next/image";
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
 * GitHub Copilot OAuth authentication plugin
 *
 * Uses GitHub's device authorization flow:
 * 1. Request device code from GitHub
 * 2. User visits verification URL and enters user code
 * 3. Poll GitHub until authorization is complete
 *
 * Supports both GitHub.com and GitHub Enterprise deployments.
 */

const OAUTH_OPTIONS: OAuthOption[] = [
	{
		id: "github.com",
		label: "GitHub.com",
		description: "Public GitHub (github.com)",
		icon: "login",
	},
	{
		id: "enterprise",
		label: "GitHub Enterprise",
		description: "Self-hosted or data residency",
		icon: "key",
	},
];

// Store device code info for polling
let pendingDeviceAuth: {
	deviceCode: string;
	domain: string;
	interval: number;
} | null = null;

async function startOAuth(optionId: string): Promise<OAuthStartResult> {
	// For enterprise, we need additional info, so we return a placeholder
	// The actual flow is handled in the UI component
	const isEnterprise = optionId === "enterprise";

	if (isEnterprise) {
		// Return placeholder - enterprise URL will be collected in UI
		return {
			url: "",
			verifier: "enterprise",
		};
	}

	// Start device flow for github.com
	const result = await api.githubCopilotDeviceCode({
		deploymentType: "github.com",
	});

	pendingDeviceAuth = {
		deviceCode: result.deviceCode,
		domain: result.domain,
		interval: result.interval,
	};

	return {
		url: result.verificationUri,
		verifier: result.userCode, // We use userCode as "verifier" for display
	};
}

async function completeOAuth(
	_code: string,
	_verifier: string,
): Promise<OAuthCompleteResult> {
	// This is called after polling succeeds
	// The actual polling and saving is done in the UI component
	if (pendingDeviceAuth) {
		mutate("credentials");
		pendingDeviceAuth = null;
	}
	return { success: true };
}

/**
 * GitHub Copilot auth plugin implementation
 */
export const githubCopilotAuthPlugin: AuthPlugin = {
	providerId: "github-copilot",
	label: "GitHub Copilot",
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
		<Image
			src="/data/models-dev/logos/github-copilot.svg"
			alt=""
			width={24}
			height={24}
			className={`${className} dark:invert`}
			style={{ objectFit: "contain" }}
			onError={() => setHasError(true)}
			unoptimized
		/>
	);
}

/**
 * Props for the GitHub Copilot OAuth flow component
 */
interface GitHubCopilotOAuthFlowProps {
	onComplete: () => void;
	onCancel: () => void;
}

type FlowStep = "select" | "enterprise-url" | "device-code" | "polling";

/**
 * GitHub Copilot OAuth flow UI component
 *
 * Multi-step flow:
 * 1. Select deployment type (GitHub.com or Enterprise)
 * 2. (Enterprise only) Enter enterprise URL
 * 3. Show device code and verification URL
 * 4. Poll for authorization completion
 */
export function GitHubCopilotOAuthFlow({
	onComplete,
	onCancel,
}: GitHubCopilotOAuthFlowProps) {
	const [step, setStep] = React.useState<FlowStep>("select");
	const [, setDeploymentType] = React.useState<"github.com" | "enterprise">(
		"github.com",
	);
	const [enterpriseUrl, setEnterpriseUrl] = React.useState("");
	const [deviceInfo, setDeviceInfo] = React.useState<{
		verificationUri: string;
		userCode: string;
		deviceCode: string;
		domain: string;
		interval: number;
	} | null>(null);
	const [isLoading, setIsLoading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [copied, setCopied] = React.useState(false);
	const pollingRef = React.useRef<NodeJS.Timeout | null>(null);

	// Cleanup polling on unmount
	React.useEffect(() => {
		return () => {
			if (pollingRef.current) {
				clearTimeout(pollingRef.current);
			}
		};
	}, []);

	const handleSelectDeployment = (type: "github.com" | "enterprise") => {
		setDeploymentType(type);
		if (type === "enterprise") {
			setStep("enterprise-url");
		} else {
			startDeviceFlow("github.com");
		}
	};

	const startDeviceFlow = async (
		type: "github.com" | "enterprise",
		entUrl?: string,
	) => {
		setIsLoading(true);
		setError(null);

		try {
			const result = await api.githubCopilotDeviceCode({
				deploymentType: type,
				enterpriseUrl: type === "enterprise" ? entUrl : undefined,
			});

			setDeviceInfo({
				verificationUri: result.verificationUri,
				userCode: result.userCode,
				deviceCode: result.deviceCode,
				domain: result.domain,
				interval: result.interval,
			});
			setStep("device-code");

			// Open verification URL
			window.open(result.verificationUri, "_blank");
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to start device flow",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleEnterpriseSubmit = () => {
		if (!enterpriseUrl.trim()) {
			setError("Enterprise URL is required");
			return;
		}

		// Validate URL
		try {
			const url = enterpriseUrl.includes("://")
				? new URL(enterpriseUrl)
				: new URL(`https://${enterpriseUrl}`);
			if (!url.hostname) {
				setError("Please enter a valid URL or domain");
				return;
			}
		} catch {
			setError("Please enter a valid URL or domain");
			return;
		}

		startDeviceFlow("enterprise", enterpriseUrl);
	};

	const startPolling = () => {
		if (!deviceInfo) return;

		setStep("polling");
		setError(null);

		const poll = async () => {
			try {
				const result = await api.githubCopilotPoll({
					deviceCode: deviceInfo.deviceCode,
					domain: deviceInfo.domain,
				});

				if (result.status === "success") {
					mutate("credentials");
					onComplete();
				} else if (result.status === "pending") {
					// Continue polling
					pollingRef.current = setTimeout(poll, deviceInfo.interval * 1000);
				} else {
					setError(result.error || "Authorization failed");
					setStep("device-code");
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Polling failed");
				setStep("device-code");
			}
		};

		poll();
	};

	const handleCopyCode = () => {
		if (deviceInfo?.userCode) {
			navigator.clipboard.writeText(deviceInfo.userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			onCancel();
		}
		if (e.key === "Enter" && step === "enterprise-url") {
			handleEnterpriseSubmit();
		}
	};

	// Step 1: Select deployment type
	if (step === "select") {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3 pb-3 border-b">
					<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
						<ProviderLogo className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">GitHub Copilot</div>
						<div className="text-xs text-muted-foreground">
							Sign in with your GitHub account
						</div>
					</div>
				</div>

				<p className="text-sm text-muted-foreground">
					Select your GitHub deployment:
				</p>

				<div className="space-y-2">
					<Button
						variant="outline"
						className="w-full justify-start gap-2"
						onClick={() => handleSelectDeployment("github.com")}
						disabled={isLoading}
					>
						<LogIn className="h-4 w-4" />
						GitHub.com
						<span className="text-xs text-muted-foreground ml-auto">
							Public
						</span>
					</Button>
					<Button
						variant="outline"
						className="w-full justify-start gap-2"
						onClick={() => handleSelectDeployment("enterprise")}
						disabled={isLoading}
					>
						<Server className="h-4 w-4" />
						GitHub Enterprise
						<span className="text-xs text-muted-foreground ml-auto">
							Self-hosted
						</span>
					</Button>
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

	// Step 2: Enterprise URL input
	if (step === "enterprise-url") {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3 pb-3 border-b">
					<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
						<ProviderLogo className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">GitHub Enterprise</div>
						<div className="text-xs text-muted-foreground">
							Enter your enterprise URL
						</div>
					</div>
				</div>

				<div className="space-y-2">
					<Label className="text-sm">Enterprise URL or Domain</Label>
					<Input
						value={enterpriseUrl}
						onChange={(e) => setEnterpriseUrl(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="company.ghe.com or https://company.ghe.com"
						disabled={isLoading}
					/>
					<p className="text-xs text-muted-foreground">
						Enter your GitHub Enterprise Server URL or domain
					</p>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}

				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm" onClick={() => setStep("select")}>
						Back
					</Button>
					<Button
						size="sm"
						onClick={handleEnterpriseSubmit}
						disabled={!enterpriseUrl.trim() || isLoading}
					>
						{isLoading ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								Connecting...
							</>
						) : (
							"Continue"
						)}
					</Button>
				</div>
			</div>
		);
	}

	// Step 3: Show device code
	if (step === "device-code" && deviceInfo) {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3 pb-3 border-b">
					<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
						<ProviderLogo className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">GitHub Copilot</div>
						<div className="text-xs text-muted-foreground">
							Enter the code on GitHub
						</div>
					</div>
				</div>

				<div className="space-y-3">
					<p className="text-sm text-muted-foreground">
						A browser window should have opened. Enter this code on GitHub to
						authorize:
					</p>

					{/* User code display */}
					<div className="flex items-center gap-2">
						<div className="flex-1 bg-muted rounded-lg p-4 text-center">
							<code className="text-2xl font-bold tracking-widest">
								{deviceInfo.userCode}
							</code>
						</div>
						<Button
							variant="outline"
							size="icon"
							className="h-14 w-14"
							onClick={handleCopyCode}
						>
							<Copy className="h-5 w-5" />
						</Button>
					</div>

					{copied && (
						<p className="text-xs text-center text-muted-foreground">
							Copied to clipboard!
						</p>
					)}

					<Button
						variant="outline"
						size="sm"
						className="w-full gap-2"
						onClick={() => window.open(deviceInfo.verificationUri, "_blank")}
					>
						<ExternalLink className="h-3.5 w-3.5" />
						Open {deviceInfo.verificationUri}
					</Button>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}

				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm" onClick={onCancel}>
						Cancel
					</Button>
					<Button size="sm" onClick={startPolling}>
						I've Entered the Code
					</Button>
				</div>
			</div>
		);
	}

	// Step 4: Polling
	if (step === "polling") {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-3 pb-3 border-b">
					<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
						<ProviderLogo className="h-5 w-5" />
					</div>
					<div>
						<div className="font-medium">GitHub Copilot</div>
						<div className="text-xs text-muted-foreground">
							Waiting for authorization...
						</div>
					</div>
				</div>

				<div className="flex flex-col items-center gap-4 py-6">
					<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
					<p className="text-sm text-muted-foreground text-center">
						Waiting for you to authorize on GitHub...
						<br />
						This will complete automatically.
					</p>
				</div>

				{error && <p className="text-sm text-destructive">{error}</p>}

				<div className="flex justify-end">
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							if (pollingRef.current) {
								clearTimeout(pollingRef.current);
							}
							onCancel();
						}}
					>
						Cancel
					</Button>
				</div>
			</div>
		);
	}

	return null;
}

export default githubCopilotAuthPlugin;
