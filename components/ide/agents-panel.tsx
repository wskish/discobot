"use client";

import {
	Bot,
	Check,
	ChevronDown,
	ChevronUp,
	MoreHorizontal,
	Plus,
} from "lucide-react";
import * as React from "react";
import { IconRenderer } from "@/components/ide/icon-renderer";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent, Icon } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { cn } from "@/lib/utils";

interface AgentsPanelProps {
	isMinimized: boolean;
	onToggleMinimize: () => void;
	className?: string;
	style?: React.CSSProperties;
}

export function AgentsPanel({
	isMinimized,
	onToggleMinimize,
	className,
	style,
}: AgentsPanelProps) {
	const { agents } = useAgents();
	const { agentTypes } = useAgentTypes();
	const { agentDialog } = useDialogContext();
	const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
		null,
	);

	return (
		<div
			className={cn(
				"flex flex-col overflow-hidden border-t border-sidebar-border",
				className,
			)}
			style={style}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: Contains nested interactive elements */}
			<div
				className="px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-sidebar-accent"
				onClick={onToggleMinimize}
				onKeyDown={(e) => e.key === "Enter" && onToggleMinimize()}
				role="button"
				tabIndex={0}
			>
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Agents
				</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							agentDialog.open();
						}}
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
						title="Add agent"
					>
						<Plus className="h-3.5 w-3.5 text-muted-foreground" />
					</button>
					<button
						type="button"
						className="p-1 rounded hover:bg-sidebar-accent transition-colors"
					>
						{isMinimized ? (
							<ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
						) : (
							<ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
						)}
					</button>
				</div>
			</div>
			{!isMinimized && (
				<div className="flex-1 overflow-y-auto py-1">
					{agents.map((agent) => {
						const agentType = agentTypes?.find((t) => t.id === agent.agentType);
						return (
							<AgentNode
								key={agent.id}
								agent={agent}
								icons={agentType?.icons}
								isSelected={selectedAgentId === agent.id}
								onSelect={() => setSelectedAgentId(agent.id)}
								onConfigure={() => agentDialog.open({ agent })}
							/>
						);
					})}
				</div>
			)}
		</div>
	);
}

const AgentNode = React.memo(function AgentNode({
	agent,
	icons,
	isSelected,
	onSelect,
	onConfigure,
}: {
	agent: Agent;
	icons?: Icon[];
	isSelected: boolean;
	onSelect: () => void;
	onConfigure: () => void;
}) {
	const [menuOpen, setMenuOpen] = React.useState(false);
	const { deleteAgent, setDefaultAgent } = useAgents();

	const handleConfigure = () => {
		onConfigure();
	};

	const handleDelete = async () => {
		await deleteAgent(agent.id);
	};

	const handleSetDefault = async () => {
		await setDefaultAgent(agent.id);
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: Contains nested interactive elements
		<div
			className={cn(
				"group flex items-center gap-1.5 px-2 py-1 hover:bg-sidebar-accent cursor-pointer transition-colors",
				isSelected && "bg-sidebar-accent",
			)}
			onClick={onSelect}
			onKeyDown={(e) => e.key === "Enter" && onSelect()}
			role="button"
			tabIndex={0}
		>
			{icons && icons.length > 0 ? (
				<IconRenderer icons={icons} size={16} className="shrink-0" />
			) : (
				<Bot className="h-4 w-4 text-muted-foreground shrink-0" />
			)}
			<div className="flex-1 min-w-0 flex items-center gap-1">
				<span className="text-sm truncate">{agent.name}</span>
				{agent.isDefault && (
					<Check className="h-3 w-3 text-muted-foreground shrink-0" />
				)}
			</div>
			<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						onClick={(e) => e.stopPropagation()}
						className={cn(
							"p-0.5 rounded hover:bg-muted shrink-0",
							menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
						)}
					>
						<MoreHorizontal className="h-4 w-4 text-muted-foreground" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-36">
					<DropdownMenuItem
						onSelect={handleSetDefault}
						disabled={agent.isDefault}
					>
						{agent.isDefault ? (
							<>
								<Check className="h-4 w-4 mr-2" />
								Default
							</>
						) : (
							"Set Default"
						)}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={handleConfigure}>
						Configure
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={handleDelete}
						className="text-destructive"
					>
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
});
