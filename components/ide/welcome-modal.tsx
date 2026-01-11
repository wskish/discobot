"use client";

import { ChevronDown, ChevronRight, Sparkles, Zap } from "lucide-react";
import * as React from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { SupportedAgentType } from "@/lib/api-types";
import { cn } from "@/lib/utils";
import { IconRenderer } from "./icon-renderer";

interface WelcomeModalProps {
	open: boolean;
	agentTypes: SupportedAgentType[];
	onSelectAgentType: (agentType: SupportedAgentType) => void;
}

const FEATURED_AGENT_IDS = ["claude-code", "opencode"];

/**
 * Welcome onboarding modal shown when no agents are configured.
 * Features Claude Code and OpenCode as premier options with an
 * expandable section for other agents.
 */
export function WelcomeModal({
	open,
	agentTypes,
	onSelectAgentType,
}: WelcomeModalProps) {
	const [showOtherAgents, setShowOtherAgents] = React.useState(false);

	const featuredAgents = React.useMemo(
		() =>
			FEATURED_AGENT_IDS.map((id) =>
				agentTypes.find((a) => a.id === id),
			).filter(Boolean) as SupportedAgentType[],
		[agentTypes],
	);

	const otherAgents = React.useMemo(
		() => agentTypes.filter((a) => !FEATURED_AGENT_IDS.includes(a.id)),
		[agentTypes],
	);

	return (
		<Dialog open={open}>
			<DialogContent
				className="sm:max-w-2xl p-0 gap-0 overflow-hidden"
				showCloseButton={false}
			>
				{/* Header with gradient background */}
				<div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-8 py-10 text-center">
					{/* Decorative elements */}
					<div className="absolute top-4 left-6 text-primary/20">
						<Sparkles className="h-6 w-6" />
					</div>
					<div className="absolute top-8 right-8 text-primary/15">
						<Zap className="h-5 w-5" />
					</div>
					<div className="absolute bottom-6 left-12 text-primary/10">
						<Zap className="h-4 w-4" />
					</div>

					<DialogHeader className="space-y-3">
						<DialogTitle className="text-3xl font-bold tracking-tight">
							Welcome to IDE Chat
						</DialogTitle>
						<DialogDescription className="text-base text-muted-foreground max-w-md mx-auto">
							Get started by adding an AI coding agent. Choose from our
							recommended agents below or explore other options.
						</DialogDescription>
					</DialogHeader>
				</div>

				{/* Content */}
				<div className="px-8 py-6 space-y-6">
					{/* Featured Agents */}
					<div className="space-y-3">
						<h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
							Recommended
						</h3>
						<div className="grid gap-3">
							{featuredAgents.map((agent) => (
								<FeaturedAgentCard
									key={agent.id}
									agent={agent}
									onSelect={() => onSelectAgentType(agent)}
									isPrimary={agent.id === "claude-code"}
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
										<OtherAgentCard
											key={agent.id}
											agent={agent}
											onSelect={() => onSelectAgentType(agent)}
										/>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

interface FeaturedAgentCardProps {
	agent: SupportedAgentType;
	onSelect: () => void;
	isPrimary?: boolean;
}

function FeaturedAgentCard({
	agent,
	onSelect,
	isPrimary,
}: FeaturedAgentCardProps) {
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
				<IconRenderer icons={agent.icons} size={28} />
			</div>

			{/* Content */}
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<h4 className="font-semibold text-foreground">{agent.name}</h4>
					{isPrimary && (
						<span className="px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide rounded-full bg-primary/10 text-primary">
							Popular
						</span>
					)}
				</div>
				<p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
					{agent.description}
				</p>
			</div>

			{/* Arrow */}
			<ChevronRight className="flex-shrink-0 h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors" />
		</button>
	);
}

interface OtherAgentCardProps {
	agent: SupportedAgentType;
	onSelect: () => void;
}

function OtherAgentCard({ agent, onSelect }: OtherAgentCardProps) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex items-center gap-3 p-3 rounded-lg border border-border bg-card text-left transition-all duration-200 hover:bg-accent/50 hover:border-primary/30"
		>
			{/* Icon */}
			<div className="flex-shrink-0 h-9 w-9 rounded-md bg-muted flex items-center justify-center">
				<IconRenderer icons={agent.icons} size={20} />
			</div>

			{/* Content */}
			<div className="flex-1 min-w-0">
				<h4 className="font-medium text-sm text-foreground">{agent.name}</h4>
				<p className="text-xs text-muted-foreground truncate">
					{agent.description}
				</p>
			</div>

			{/* Arrow */}
			<ChevronRight className="flex-shrink-0 h-4 w-4 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
		</button>
	);
}
