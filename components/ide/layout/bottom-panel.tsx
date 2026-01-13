"use client";

import { ChatPanel } from "@/components/ide/chat-panel";
import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
import { TerminalView } from "@/components/ide/terminal-view";
import { Button } from "@/components/ui/button";
import type {
	Agent,
	ChatMessage,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";

type BottomView = "chat" | "terminal";

interface BottomPanelProps {
	panelState: PanelState;
	style: React.CSSProperties;
	showPanelControls: boolean;
	view: BottomView;
	onViewChange: (view: BottomView) => void;
	onMinimize: () => void;
	onMaximize: () => void;
	// Chat props
	messages: ChatMessage[];
	sessionAgent: Agent | null;
	sessionWorkspace: Workspace | null;
	agentTypes: SupportedAgentType[];
	agents: Agent[];
}

export function BottomPanel({
	panelState,
	style,
	showPanelControls,
	view,
	onViewChange,
	onMinimize,
	onMaximize,
	messages,
	sessionAgent,
	sessionWorkspace,
	agentTypes,
	agents,
}: BottomPanelProps) {
	return (
		<div className="flex flex-col overflow-hidden" style={style}>
			{/* Bottom panel header */}
			<div className="h-10 flex items-center justify-between px-2 bg-muted/30 border-b border-border shrink-0">
				<div className="flex items-center gap-2">
					<Button
						variant={view === "chat" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs"
						onClick={() => onViewChange("chat")}
					>
						Chat
					</Button>
					<Button
						variant={view === "terminal" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs"
						onClick={() => onViewChange("terminal")}
					>
						Terminal
					</Button>
				</div>
				{showPanelControls && (
					<PanelControls
						state={panelState}
						onMinimize={onMinimize}
						onMaximize={onMaximize}
					/>
				)}
			</div>
			{panelState !== "minimized" && (
				<div className="flex-1 overflow-hidden">
					{view === "terminal" ? (
						<TerminalView
							className="h-full"
							onToggleChat={() => onViewChange("chat")}
							hideHeader
						/>
					) : (
						<ChatPanel
							initialMessages={messages}
							className="h-full"
							sessionAgent={sessionAgent}
							sessionWorkspace={sessionWorkspace}
							agentTypes={agentTypes}
							agents={agents}
						/>
					)}
				</div>
			)}
		</div>
	);
}
