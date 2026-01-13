"use client";

import * as React from "react";
import { AgentsPanel } from "@/components/ide/agents-panel";
import { ResizeHandle } from "@/components/ide/resize-handle";
import { SidebarTree } from "@/components/ide/sidebar-tree";
import type {
	Agent,
	Session,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface LeftSidebarProps {
	isOpen: boolean;
	workspaces: Workspace[];
	agents: Agent[];
	agentTypes: SupportedAgentType[];
	selectedSessionId: string | null;
	selectedAgentId: string | null;
	onSessionSelect: (session: Session) => void;
	onAgentSelect: (agent: Agent | null) => void;
	onAddWorkspace: () => void;
	onAddSession: (workspaceId: string) => void;
	onDeleteWorkspace: (workspace: Workspace) => void;
	onAddAgent: () => void;
	onConfigureAgent: (agent: Agent) => void;
}

export function LeftSidebar({
	isOpen,
	workspaces,
	agents,
	agentTypes,
	selectedSessionId,
	selectedAgentId,
	onSessionSelect,
	onAgentSelect,
	onAddWorkspace,
	onAddSession,
	onDeleteWorkspace,
	onAddAgent,
	onConfigureAgent,
}: LeftSidebarProps) {
	const [agentsPanelMinimized, setAgentsPanelMinimized] = React.useState(false);
	const [agentsPanelHeight, setAgentsPanelHeight] = React.useState(20);
	const sidebarRef = React.useRef<HTMLDivElement>(null);

	const handleSidebarResize = React.useCallback((delta: number) => {
		if (!sidebarRef.current) return;
		const containerHeight = sidebarRef.current.clientHeight;
		const deltaPercent = (delta / containerHeight) * 100;
		setAgentsPanelHeight((prev) =>
			Math.min(60, Math.max(15, prev - deltaPercent)),
		);
	}, []);

	return (
		<aside
			ref={sidebarRef}
			className={cn(
				"border-r border-border bg-sidebar transition-all duration-300 overflow-hidden flex flex-col",
				isOpen ? "w-64" : "w-0",
			)}
		>
			{/* Workspaces section - takes remaining space */}
			<SidebarTree
				workspaces={workspaces}
				onSessionSelect={onSessionSelect}
				selectedSessionId={selectedSessionId}
				onAddWorkspace={onAddWorkspace}
				onAddSession={onAddSession}
				onDeleteWorkspace={onDeleteWorkspace}
				className="flex-1 min-h-0"
			/>

			{/* Resize handle between workspaces and agents */}
			{!agentsPanelMinimized && <ResizeHandle onResize={handleSidebarResize} />}

			{/* Agents section - 20% default */}
			<AgentsPanel
				agents={agents}
				agentTypes={agentTypes}
				selectedAgentId={selectedAgentId}
				onAgentSelect={onAgentSelect}
				onAddAgent={onAddAgent}
				onConfigureAgent={onConfigureAgent}
				isMinimized={agentsPanelMinimized}
				onToggleMinimize={() => setAgentsPanelMinimized(!agentsPanelMinimized)}
				style={agentsPanelMinimized ? {} : { height: `${agentsPanelHeight}%` }}
			/>
		</aside>
	);
}
