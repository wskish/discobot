"use client";

import { ArrowLeft, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import * as React from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	AuthProvider,
	CredentialInfo,
	SupportedAgentType,
} from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { IconRenderer } from "./icon-renderer";
import { OctobotLogo } from "./octobot-logo";

interface WelcomeModalProps {
	open: boolean;
	agentTypes: SupportedAgentType[];
	authProviders: AuthProvider[];
	configuredCredentials: CredentialInfo[];
	onComplete: (
		agentType: SupportedAgentType,
		authProviderId: string | null,
	) => void;
}

type Step = "agent" | "auth";

/**
 * Welcome onboarding modal shown when no agents are configured.
 * Features a two-step flow:
 * 1. Select an AI coding agent
 * 2. Select an auth provider (if needed)
 */
export function WelcomeModal({
	open,
	agentTypes,
	authProviders,
	configuredCredentials,
	onComplete,
}: WelcomeModalProps) {
	const [step, setStep] = React.useState<Step>("agent");
	const [selectedAgent, setSelectedAgent] =
		React.useState<SupportedAgentType | null>(null);
	const [showOtherAgents, setShowOtherAgents] = React.useState(false);
	const [showOtherProviders, setShowOtherProviders] = React.useState(false);

	// Reset state when modal opens
	React.useEffect(() => {
		if (open) {
			setStep("agent");
			setSelectedAgent(null);
			setShowOtherAgents(false);
			setShowOtherProviders(false);
		}
	}, [open]);

	const featuredAgents = React.useMemo(
		() => agentTypes.filter((a) => a.highlighted),
		[agentTypes],
	);

	const otherAgents = React.useMemo(
		() => agentTypes.filter((a) => !a.highlighted),
		[agentTypes],
	);

	// Get configured provider IDs
	const configuredProviderIds = React.useMemo(
		() =>
			new Set(
				configuredCredentials
					.filter((c) => c.isConfigured)
					.map((c) => c.provider),
			),
		[configuredCredentials],
	);

	// Handle agent selection
	const handleSelectAgent = (agent: SupportedAgentType) => {
		const supportedProviders = agent.supportedAuthProviders || [];
		const supportsAll = supportedProviders.includes("*");

		// Check if user has any configured credentials for this agent
		const hasConfiguredProvider = supportsAll
			? configuredProviderIds.size > 0
			: supportedProviders.some((p) => configuredProviderIds.has(p));

		if (hasConfiguredProvider) {
			// User already has valid credentials, complete immediately
			onComplete(agent, null);
		} else if (supportedProviders.length === 0 && agent.allowNoAuth) {
			// Agent doesn't need auth and allows no auth
			onComplete(agent, null);
		} else {
			// Need to select auth provider
			setSelectedAgent(agent);
			setStep("auth");
		}
	};

	// Handle auth provider selection
	const handleSelectAuthProvider = (providerId: string | null) => {
		if (selectedAgent) {
			onComplete(selectedAgent, providerId);
		}
	};

	// Go back to agent selection
	const handleBack = () => {
		setStep("agent");
		setSelectedAgent(null);
		setShowOtherProviders(false);
	};

	// Get available auth providers for selected agent
	const availableProviders = React.useMemo(() => {
		if (!selectedAgent) return [];
		const supported = selectedAgent.supportedAuthProviders || [];
		// "*" means all providers are supported
		if (supported.includes("*")) {
			return authProviders;
		}
		// Map in order of supportedAuthProviders to respect agent's preferred order
		return supported
			.map((id) => authProviders.find((p) => p.id === id))
			.filter((p): p is AuthProvider => p !== undefined);
	}, [selectedAgent, authProviders]);

	// Get highlighted auth providers for this agent
	const highlightedProviderIds = React.useMemo(() => {
		return new Set(selectedAgent?.highlightedAuthProviders || []);
	}, [selectedAgent]);

	// Featured providers (from highlightedAuthProviders) and others
	const featuredProviders = React.useMemo(() => {
		if (!selectedAgent?.highlightedAuthProviders?.length) {
			// Fallback to first 2 if no highlighted providers specified
			return availableProviders.slice(0, 2);
		}
		// Return highlighted providers in the order specified
		return selectedAgent.highlightedAuthProviders
			.map((id) => authProviders.find((p) => p.id === id))
			.filter((p): p is AuthProvider => p !== undefined);
	}, [selectedAgent, authProviders, availableProviders]);

	const otherProvidersList = React.useMemo(() => {
		return availableProviders.filter((p) => !highlightedProviderIds.has(p.id));
	}, [availableProviders, highlightedProviderIds]);

	return (
		<Dialog open={open}>
			<DialogContent
				className="sm:max-w-2xl p-0 gap-0 overflow-hidden max-h-[90vh] flex flex-col"
				showCloseButton={false}
			>
				{/* Header with gradient background */}
				<div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-8 py-10 text-center flex-shrink-0">
					{/* Back button for step 2 */}
					{step === "auth" && (
						<button
							type="button"
							onClick={handleBack}
							className="absolute left-4 top-4 p-2 rounded-lg hover:bg-background/50 transition-colors text-muted-foreground hover:text-foreground"
						>
							<ArrowLeft className="h-5 w-5" />
						</button>
					)}

					{/* Logo */}
					<div className="flex justify-center mb-4">
						<OctobotLogo size={64} className="text-primary" />
					</div>

					<DialogHeader className="space-y-3">
						<DialogTitle className="text-3xl font-bold tracking-tight">
							Welcome to Octobot
						</DialogTitle>
						<DialogDescription className="text-base text-muted-foreground max-w-md mx-auto">
							{step === "agent" ? (
								"Get started by adding an AI coding agent. Choose from our recommended agents below or explore other options."
							) : (
								<>
									Select how you want to authenticate with{" "}
									<span className="font-medium text-foreground">
										{selectedAgent?.name}
									</span>
									.
								</>
							)}
						</DialogDescription>
					</DialogHeader>
				</div>

				{/* Content */}
				<div className="px-8 py-6 space-y-6 flex-1 overflow-y-auto">
					{step === "agent" ? (
						<>
							{/* Featured Agents */}
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
									Recommended
								</h3>
								<div className="grid gap-3">
									{featuredAgents.map((agent, index) => (
										<FeaturedCard
											key={agent.id}
											icon={<IconRenderer icons={agent.icons} size={28} />}
											name={agent.name}
											description={agent.description}
											badges={agent.badges}
											onSelect={() => handleSelectAgent(agent)}
											isPrimary={index === 0}
										/>
									))}
								</div>
							</div>

							{/* Other Agents */}
							{otherAgents.length > 0 && (
								<div className="space-y-3">
									<button
										type="button"
										onClick={() => setShowOtherAgents(!showOtherAgents)}
										className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group"
									>
										<ChevronDown
											className={cn(
												"h-4 w-4 transition-transform duration-200",
												showOtherAgents && "rotate-180",
											)}
										/>
										<span>Other Agents</span>
										<span className="text-xs text-muted-foreground/60">
											({otherAgents.length})
										</span>
									</button>

									{showOtherAgents && (
										<div className="grid gap-2 pl-6 animate-in slide-in-from-top-2 duration-200">
											{otherAgents.map((agent) => (
												<CompactCard
													key={agent.id}
													icon={<IconRenderer icons={agent.icons} size={20} />}
													name={agent.name}
													description={agent.description}
													onSelect={() => handleSelectAgent(agent)}
												/>
											))}
										</div>
									)}
								</div>
							)}
						</>
					) : (
						<>
							{/* Auth Provider Selection */}
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
									Authentication
								</h3>
								<div className="grid gap-3">
									{/* Free option for agents that allow no auth */}
									{selectedAgent?.allowNoAuth && (
										<FeaturedCard
											icon={
												<div className="h-7 w-7 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center">
													<Sparkles className="h-4 w-4 text-white" />
												</div>
											}
											name="Free"
											description="Use without authentication - some features may be limited"
											badges={[
												{
													label: "No Setup",
													className:
														"bg-green-500/10 text-green-600 dark:text-green-400",
												},
											]}
											onSelect={() => handleSelectAuthProvider(null)}
											isPrimary
										/>
									)}

									{/* Featured providers */}
									{featuredProviders.map((provider) => (
										<FeaturedCard
											key={provider.id}
											icon={<IconRenderer icons={provider.icons} size={28} />}
											name={provider.name}
											description={
												provider.description ||
												`Authenticate with ${provider.name}`
											}
											onSelect={() => handleSelectAuthProvider(provider.id)}
											isPrimary={
												!selectedAgent?.allowNoAuth &&
												provider.id === featuredProviders[0]?.id
											}
										/>
									))}
								</div>
							</div>

							{/* Other Providers */}
							{otherProvidersList.length > 0 && (
								<div className="space-y-3">
									<button
										type="button"
										onClick={() => setShowOtherProviders(!showOtherProviders)}
										className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors group"
									>
										<ChevronDown
											className={cn(
												"h-4 w-4 transition-transform duration-200",
												showOtherProviders && "rotate-180",
											)}
										/>
										<span>Other Providers</span>
										<span className="text-xs text-muted-foreground/60">
											({otherProvidersList.length})
										</span>
									</button>

									{showOtherProviders && (
										<div className="grid gap-2 pl-6 animate-in slide-in-from-top-2 duration-200">
											{otherProvidersList.map((provider) => (
												<CompactCard
													key={provider.id}
													icon={
														<IconRenderer icons={provider.icons} size={20} />
													}
													name={provider.name}
													description={
														provider.description ||
														`Authenticate with ${provider.name}`
													}
													onSelect={() => handleSelectAuthProvider(provider.id)}
												/>
											))}
										</div>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

interface FeaturedCardProps {
	icon: React.ReactNode;
	name: string;
	description?: string;
	badges?: { label: string; className: string }[];
	onSelect: () => void;
	isPrimary?: boolean;
}

function FeaturedCard({
	icon,
	name,
	description,
	badges = [],
	onSelect,
	isPrimary,
}: FeaturedCardProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"group relative flex items-center gap-4 p-4 rounded-xl border text-left transition-all duration-200",
				"hover:shadow-md hover:border-primary/50 hover:bg-accent/50",
				isPrimary
					? "bg-primary/5 border-primary/20 ring-1 ring-primary/10"
					: "bg-card border-border",
			)}
		>
			{/* Icon */}
			<div
				className={cn(
					"flex-shrink-0 h-12 w-12 rounded-lg flex items-center justify-center",
					isPrimary ? "bg-primary/10" : "bg-muted",
				)}
			>
				{icon}
			</div>

			{/* Content */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2 flex-wrap">
					<h4 className="font-semibold text-foreground">{name}</h4>
					{badges.map((badge) => (
						<span
							key={badge.label}
							className={cn(
								"px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full",
								badge.className,
							)}
						>
							{badge.label}
						</span>
					))}
				</div>
				{description && (
					<p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
						{description}
					</p>
				)}
			</div>

			{/* Arrow */}
			<ChevronRight className="flex-shrink-0 h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
		</button>
	);
}

interface CompactCardProps {
	icon: React.ReactNode;
	name: string;
	description?: string;
	onSelect: () => void;
}

function CompactCard({ icon, name, description, onSelect }: CompactCardProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex items-center gap-3 p-3 rounded-lg border border-border bg-card text-left transition-all duration-200 hover:bg-accent/50 hover:border-primary/30"
		>
			{/* Icon */}
			<div className="flex-shrink-0 h-9 w-9 rounded-md bg-muted flex items-center justify-center">
				{icon}
			</div>

			{/* Content */}
			<div className="flex-1 min-w-0">
				<h4 className="font-medium text-sm text-foreground">{name}</h4>
				{description && (
					<p className="text-xs text-muted-foreground truncate">
						{description}
					</p>
				)}
			</div>

			{/* Arrow */}
			<ChevronRight className="flex-shrink-0 h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
		</button>
	);
}
