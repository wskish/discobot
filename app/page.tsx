"use client";

import { PanelLeft, PanelLeftClose, Plus } from "lucide-react";
import * as React from "react";
import { AddAgentDialog } from "@/components/ide/add-agent-dialog";
import { AddWorkspaceDialog } from "@/components/ide/add-workspace-dialog";
import { AgentsPanel } from "@/components/ide/agents-panel";
import { ChatPanel } from "@/components/ide/chat-panel";
import { FilePanel } from "@/components/ide/file-panel";
import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
import { ResizeHandle } from "@/components/ide/resize-handle";
import { SidebarTree } from "@/components/ide/sidebar-tree";
import { TabbedDiffView } from "@/components/ide/tabbed-diff-view";
import { TerminalView } from "@/components/ide/terminal-view";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { Button } from "@/components/ui/button";
import type {
	Agent,
	CreateAgentRequest,
	CreateWorkspaceRequest,
	FileNode,
	Session,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useMessages } from "@/lib/hooks/use-messages";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { cn } from "@/lib/utils";

type BottomView = "chat" | "terminal";

export default function IDEChatPage() {
	const [leftSidebarOpen, setLeftSidebarOpen] = React.useState(true);
	const [selectedSession, setSelectedSession] = React.useState<Session | null>(
		null,
	);
	const [selectedAgent, setSelectedAgent] = React.useState<Agent | null>(null);

	const {
		workspaces,
		createWorkspace,
		isLoading: workspacesLoading,
		mutate: mutateWorkspaces,
	} = useWorkspaces();
	const {
		agents,
		createAgent,
		updateAgent,
		isLoading: agentsLoading,
		mutate: mutateAgents,
	} = useAgents();
	const { agentTypes } = useAgentTypes(); // Add useAgentTypes hook to get agent type icons
	const { messages } = useMessages(selectedSession?.id || null);

	const [agentsPanelMinimized, setAgentsPanelMinimized] = React.useState(false);
	const [agentsPanelHeight, setAgentsPanelHeight] = React.useState(20);
	const sidebarRef = React.useRef<HTMLDivElement>(null);

	const [diffPanelState, setDiffPanelState] =
		React.useState<PanelState>("normal");
	const [bottomPanelState, setBottomPanelState] =
		React.useState<PanelState>("normal");
	const [bottomView, setBottomView] = React.useState<BottomView>("chat");
	const [showDiffPanel, setShowDiffPanel] = React.useState(false);

	const [diffPanelHeight, setDiffPanelHeight] = React.useState(50);
	const mainRef = React.useRef<HTMLDivElement>(null);

	const [openFiles, setOpenFiles] = React.useState<FileNode[]>([]);
	const [activeFileId, setActiveFileId] = React.useState<string | null>(null);

	const [preselectedWorkspaceId, setPreselectedWorkspaceId] = React.useState<
		string | null
	>(null);
	const [workspaceSelectTrigger, setWorkspaceSelectTrigger] = React.useState(0);

	const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] =
		React.useState(false);
	const [showAddAgentDialog, setShowAddAgentDialog] = React.useState(false);
	const [editingAgent, setEditingAgent] = React.useState<Agent | null>(null);

	// ... existing code for handlers ...
	const handleDiffMinimize = () => {
		if (diffPanelState === "minimized") {
			setDiffPanelState("normal");
			setBottomPanelState("normal");
		} else {
			setDiffPanelState("minimized");
			setBottomPanelState("maximized");
		}
	};

	const handleDiffMaximize = () => {
		if (diffPanelState === "maximized") {
			setDiffPanelState("normal");
			setBottomPanelState("normal");
		} else {
			setDiffPanelState("maximized");
			setBottomPanelState("minimized");
		}
	};

	const handleBottomMinimize = () => {
		if (bottomPanelState === "minimized") {
			setBottomPanelState("normal");
			setDiffPanelState("normal");
		} else {
			setBottomPanelState("minimized");
			if (showDiffPanel) {
				setDiffPanelState("maximized");
			}
		}
	};

	const handleBottomMaximize = () => {
		if (bottomPanelState === "maximized") {
			setBottomPanelState("normal");
			setDiffPanelState("normal");
		} else {
			setBottomPanelState("maximized");
			setDiffPanelState("minimized");
		}
	};

	const handleResize = React.useCallback((delta: number) => {
		if (!mainRef.current) return;
		const containerHeight = mainRef.current.clientHeight;
		const deltaPercent = (delta / containerHeight) * 100;
		setDiffPanelHeight((prev) =>
			Math.min(80, Math.max(20, prev + deltaPercent)),
		);
	}, []);

	const handleSidebarResize = React.useCallback((delta: number) => {
		if (!sidebarRef.current) return;
		const containerHeight = sidebarRef.current.clientHeight;
		const deltaPercent = (delta / containerHeight) * 100;
		setAgentsPanelHeight((prev) =>
			Math.min(60, Math.max(15, prev - deltaPercent)),
		);
	}, []);

	const handleSessionSelect = (session: Session) => {
		setSelectedSession(session);
		setOpenFiles([]);
		setActiveFileId(null);
		setShowDiffPanel(false);
		setDiffPanelState("normal");
		setBottomPanelState("normal");
		setPreselectedWorkspaceId(null);
	};

	const handleFileSelect = (file: FileNode) => {
		if (file.type === "file") {
			if (!openFiles.find((f) => f.id === file.id)) {
				setOpenFiles([...openFiles, file]);
			}
			setActiveFileId(file.id);
			setShowDiffPanel(true);
			if (diffPanelState === "minimized") {
				setDiffPanelState("normal");
			}
		}
	};

	const handleTabClose = (fileId: string) => {
		const newOpenFiles = openFiles.filter((f) => f.id !== fileId);
		setOpenFiles(newOpenFiles);

		if (activeFileId === fileId) {
			if (newOpenFiles.length > 0) {
				setActiveFileId(newOpenFiles[newOpenFiles.length - 1].id);
			} else {
				setActiveFileId(null);
				setShowDiffPanel(false);
			}
		}
	};

	const handleTabSelect = (file: FileNode) => {
		setActiveFileId(file.id);
	};

	const handleCloseDiffPanel = () => {
		setShowDiffPanel(false);
		setOpenFiles([]);
		setActiveFileId(null);
		setDiffPanelState("normal");
		if (bottomPanelState === "minimized") {
			setBottomPanelState("normal");
		}
	};

	const getDiffPanelStyle = (): React.CSSProperties => {
		if (!showDiffPanel) return { height: 0 };
		if (diffPanelState === "minimized") return { height: 40 };
		if (diffPanelState === "maximized") return { flex: 1 };
		return { height: `${diffPanelHeight}%` };
	};

	const getBottomPanelStyle = (): React.CSSProperties => {
		if (bottomPanelState === "minimized") return { height: 40 };
		if (bottomPanelState === "maximized") return { flex: 1 };
		if (!showDiffPanel) return { flex: 1 };
		return { flex: 1 };
	};

	const showResizeHandle =
		showDiffPanel &&
		diffPanelState === "normal" &&
		bottomPanelState === "normal";

	const handleAddWorkspace = async (newWorkspace: CreateWorkspaceRequest) => {
		await createWorkspace(newWorkspace);
		setShowAddWorkspaceDialog(false);
	};

	const _handleAddAgent = async (newAgent: CreateAgentRequest) => {
		const agent = await createAgent(newAgent);
		setShowAddAgentDialog(false);
		// Select the newly created agent
		if (agent) {
			setSelectedAgent(agent);
		}
	};

	const handleAddSession = (workspaceId: string) => {
		setSelectedSession(null);
		setPreselectedWorkspaceId(workspaceId);
		setWorkspaceSelectTrigger((prev) => prev + 1);
		setOpenFiles([]);
		setActiveFileId(null);
		setShowDiffPanel(false);
	};

	const handleFirstMessage = async (
		message: string,
		workspaceId: string,
		agentId: string,
	) => {
		const sessionName =
			message.length > 50 ? `${message.substring(0, 50)}...` : message;

		const newSession: Session = {
			id: `session-${Date.now()}`,
			name: sessionName,
			description: message,
			timestamp: "Just now",
			status: "running",
			files: [],
			workspaceId,
			agentId,
		};

		// Optimistically update local state and re-fetch
		mutateWorkspaces();

		setSelectedSession(newSession);
		setPreselectedWorkspaceId(null);
		const agent = agents.find((a) => a.id === agentId);
		if (agent) {
			setSelectedAgent(agent);
		}
	};

	const handleNewSession = () => {
		setSelectedSession(null);
		setPreselectedWorkspaceId(null);
		setOpenFiles([]);
		setActiveFileId(null);
		setShowDiffPanel(false);
	};

	const handleEditAgent = (agent: Agent) => {
		setEditingAgent(agent);
		setShowAddAgentDialog(true);
	};

	const handleAddOrEditAgent = async (agentData: CreateAgentRequest) => {
		if (editingAgent) {
			// Update existing agent
			await updateAgent(editingAgent.id, agentData);
			mutateAgents();
			setEditingAgent(null);
		} else {
			// Create new agent
			const agent = await createAgent(agentData);
			if (agent) {
				setSelectedAgent(agent);
			}
		}
		setShowAddAgentDialog(false);
	};

	const handleAgentDialogClose = (open: boolean) => {
		if (!open) {
			setEditingAgent(null);
		}
		setShowAddAgentDialog(open);
	};

	const showFilePanel = selectedSession !== null;
	const showCenteredChat = selectedSession === null;

	const sessionAgent = React.useMemo(() => {
		if (!selectedSession?.agentId) return null;
		return agents.find((a) => a.id === selectedSession.agentId) || null;
	}, [selectedSession, agents]);

	const sessionWorkspace = React.useMemo(() => {
		if (!selectedSession?.workspaceId) return null;
		for (const ws of workspaces) {
			if (ws.id === selectedSession.workspaceId) return ws;
		}
		return null;
	}, [selectedSession, workspaces]);

	// Show loading state
	if (workspacesLoading || agentsLoading) {
		return (
			<div className="h-screen flex items-center justify-center bg-background">
				<div className="text-muted-foreground">Loading...</div>
			</div>
		);
	}

	return (
		<div className="h-screen flex flex-col bg-background">
			{/* Top bar */}
			<header className="h-12 border-b border-border flex items-center justify-between px-4">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => setLeftSidebarOpen(!leftSidebarOpen)}
					>
						{leftSidebarOpen ? (
							<PanelLeftClose className="h-4 w-4" />
						) : (
							<PanelLeft className="h-4 w-4" />
						)}
					</Button>
					<span className="font-semibold">IDE Chat</span>
					<Button
						variant="ghost"
						size="sm"
						className="gap-1.5 text-muted-foreground"
						onClick={handleNewSession}
					>
						<Plus className="h-4 w-4" />
						New Session
					</Button>
				</div>
				<div className="flex items-center gap-2">
					<ThemeToggle />
				</div>
			</header>

			{/* Main content */}
			<div className="flex-1 flex overflow-hidden">
				<aside
					ref={sidebarRef}
					className={cn(
						"border-r border-border bg-sidebar transition-all duration-300 overflow-hidden flex flex-col",
						leftSidebarOpen ? "w-64" : "w-0",
					)}
				>
					{/* Workspaces section - takes remaining space */}
					<SidebarTree
						workspaces={workspaces}
						onSessionSelect={handleSessionSelect}
						selectedSessionId={selectedSession?.id || null}
						onAddWorkspace={() => setShowAddWorkspaceDialog(true)}
						onAddSession={handleAddSession}
						className="flex-1 min-h-0"
					/>

					{/* Resize handle between workspaces and agents */}
					{!agentsPanelMinimized && (
						<ResizeHandle onResize={handleSidebarResize} />
					)}

					{/* Agents section - 20% default */}
					<AgentsPanel
						agents={agents}
						agentTypes={agentTypes} // Pass agentTypes to display correct icons
						selectedAgentId={selectedAgent?.id || null}
						onAgentSelect={setSelectedAgent}
						onAddAgent={() => {
							setEditingAgent(null);
							setShowAddAgentDialog(true);
						}}
						onConfigureAgent={handleEditAgent}
						isMinimized={agentsPanelMinimized}
						onToggleMinimize={() =>
							setAgentsPanelMinimized(!agentsPanelMinimized)
						}
						style={
							agentsPanelMinimized ? {} : { height: `${agentsPanelHeight}%` }
						}
					/>
				</aside>

				{showCenteredChat ? (
					<main className="flex-1 flex items-center justify-center overflow-hidden">
						<ChatPanel
							initialMessages={[]}
							onToggleTerminal={() => setBottomView("terminal")}
							showTerminal={false}
							centered
							onFirstMessage={handleFirstMessage}
							workspaces={workspaces}
							selectedWorkspaceId={preselectedWorkspaceId}
							onAddWorkspace={() => setShowAddWorkspaceDialog(true)}
							className="w-full h-full"
							workspaceSelectTrigger={workspaceSelectTrigger}
							agents={agents}
							selectedAgentId={selectedAgent?.id || null}
							onAddAgent={() => setShowAddAgentDialog(true)}
							agentTypes={agentTypes}
						/>
					</main>
				) : (
					<>
						<main
							ref={mainRef}
							className="flex-1 flex flex-col overflow-hidden"
						>
							{/* Top: Diff panel with tabs (when files are open) */}
							{showDiffPanel && (
								<div
									className="flex flex-col border-b border-border transition-all overflow-hidden"
									style={getDiffPanelStyle()}
								>
									<div className="h-10 flex items-center justify-between px-2 bg-muted/30 border-b border-border shrink-0">
										<span className="text-sm font-medium text-muted-foreground px-2">
											Files
										</span>
										<PanelControls
											state={diffPanelState}
											onMinimize={handleDiffMinimize}
											onMaximize={handleDiffMaximize}
											onClose={handleCloseDiffPanel}
											showClose
										/>
									</div>
									{diffPanelState !== "minimized" && (
										<TabbedDiffView
											openFiles={openFiles}
											activeFileId={activeFileId}
											onTabSelect={handleTabSelect}
											onTabClose={handleTabClose}
											className="flex-1 overflow-hidden"
											hideEmptyState
										/>
									)}
								</div>
							)}

							{showResizeHandle && <ResizeHandle onResize={handleResize} />}

							<div
								className="flex flex-col overflow-hidden"
								style={getBottomPanelStyle()}
							>
								{/* Bottom panel header */}
								<div className="h-10 flex items-center justify-between px-2 bg-muted/30 border-b border-border shrink-0">
									<div className="flex items-center gap-2">
										<Button
											variant={bottomView === "chat" ? "secondary" : "ghost"}
											size="sm"
											className="h-6 text-xs"
											onClick={() => setBottomView("chat")}
										>
											Chat
										</Button>
										<Button
											variant={
												bottomView === "terminal" ? "secondary" : "ghost"
											}
											size="sm"
											className="h-6 text-xs"
											onClick={() => setBottomView("terminal")}
										>
											Terminal
										</Button>
									</div>
									{showDiffPanel && (
										<PanelControls
											state={bottomPanelState}
											onMinimize={handleBottomMinimize}
											onMaximize={handleBottomMaximize}
										/>
									)}
								</div>
								{bottomPanelState !== "minimized" && (
									<div className="flex-1 overflow-hidden">
										{bottomView === "terminal" ? (
											<TerminalView
												className="h-full"
												onToggleChat={() => setBottomView("chat")}
												hideHeader
											/>
										) : (
											<ChatPanel
												initialMessages={messages}
												onToggleTerminal={() => setBottomView("terminal")}
												showTerminal={false}
												className="h-full"
												hideHeader
												sessionAgent={sessionAgent}
												sessionWorkspace={sessionWorkspace}
												agentTypes={agentTypes}
												agents={agents}
											/>
										)}
									</div>
								)}
							</div>
						</main>

						{/* Right - File panel (only show when session is selected) */}
						{showFilePanel && (
							<FilePanel
								session={selectedSession}
								onFileSelect={handleFileSelect}
								selectedFileId={activeFileId}
								className="w-56"
							/>
						)}
					</>
				)}
			</div>

			<AddWorkspaceDialog
				open={showAddWorkspaceDialog}
				onOpenChange={setShowAddWorkspaceDialog}
				onAdd={handleAddWorkspace}
			/>

			<AddAgentDialog
				open={showAddAgentDialog}
				onOpenChange={handleAgentDialogClose}
				onAdd={handleAddOrEditAgent}
				editingAgent={editingAgent}
			/>
		</div>
	);
}
