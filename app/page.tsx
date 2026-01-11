"use client";

import * as React from "react";
import { AddAgentDialog } from "@/components/ide/add-agent-dialog";
import { AddWorkspaceDialog } from "@/components/ide/add-workspace-dialog";
import { Header, LeftSidebar, MainContent } from "@/components/ide/layout";
import { WelcomeModal } from "@/components/ide/welcome-modal";
import { api } from "@/lib/api-client";
import type {
	Agent,
	CreateAgentRequest,
	CreateWorkspaceRequest,
	Session,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useDialogState } from "@/lib/hooks/use-dialog-state";
import { useMessages } from "@/lib/hooks/use-messages";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";

export default function IDEChatPage() {
	const [leftSidebarOpen, setLeftSidebarOpen] = usePersistedState(
		STORAGE_KEYS.LEFT_SIDEBAR_OPEN,
		true,
	);
	const [selectedSession, setSelectedSession] = React.useState<Session | null>(
		null,
	);
	const [selectedAgent, setSelectedAgent] = React.useState<Agent | null>(null);
	const [preselectedWorkspaceId, setPreselectedWorkspaceId] = React.useState<
		string | null
	>(null);
	const [workspaceSelectTrigger, setWorkspaceSelectTrigger] = React.useState(0);

	// Data fetching
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
	const { agentTypes } = useAgentTypes();
	const { messages } = useMessages(selectedSession?.id || null);

	// Dialog state
	const dialogs = useDialogState();
	const [credentialsOpen, setCredentialsOpen] = React.useState(false);
	const [credentialsInitialProviderId, setCredentialsInitialProviderId] =
		React.useState<string | null>(null);

	// Reset initial provider when credentials dialog closes
	const handleCredentialsOpenChange = React.useCallback((open: boolean) => {
		setCredentialsOpen(open);
		if (!open) {
			setCredentialsInitialProviderId(null);
		}
	}, []);

	const openCredentialsForProvider = React.useCallback(
		(providerId?: string) => {
			setCredentialsInitialProviderId(providerId || null);
			setCredentialsOpen(true);
		},
		[],
	);

	// Computed values
	const sessionAgent = React.useMemo(() => {
		if (!selectedSession?.agentId) return null;
		return agents.find((a) => a.id === selectedSession.agentId) || null;
	}, [selectedSession, agents]);

	const sessionWorkspace = React.useMemo(() => {
		if (!selectedSession?.workspaceId) return null;
		return (
			workspaces.find((ws) => ws.id === selectedSession.workspaceId) || null
		);
	}, [selectedSession, workspaces]);

	// Handlers
	const handleSessionSelect = React.useCallback((session: Session) => {
		setSelectedSession(session);
		setPreselectedWorkspaceId(null);
	}, []);

	const handleNewSession = React.useCallback(() => {
		setSelectedSession(null);
		setPreselectedWorkspaceId(null);
	}, []);

	const handleAddSession = React.useCallback((workspaceId: string) => {
		setSelectedSession(null);
		setPreselectedWorkspaceId(workspaceId);
		setWorkspaceSelectTrigger((prev) => prev + 1);
	}, []);

	const handleAddWorkspace = async (newWorkspace: CreateWorkspaceRequest) => {
		await createWorkspace(newWorkspace);
		dialogs.closeWorkspaceDialog();
	};

	const handleAddOrEditAgent = async (agentData: CreateAgentRequest) => {
		if (dialogs.editingAgent) {
			await updateAgent(dialogs.editingAgent.id, agentData);
			mutateAgents();
		} else {
			const agent = await createAgent(agentData);
			if (agent) {
				setSelectedAgent(agent);
			}
		}
		dialogs.closeAgentDialog();
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

		mutateWorkspaces();
		setSelectedSession(newSession);
		setPreselectedWorkspaceId(null);

		const agent = agents.find((a) => a.id === agentId);
		if (agent) {
			setSelectedAgent(agent);
		}
	};

	const handleCloseSession = React.useCallback(
		async (saveChanges: boolean) => {
			if (!selectedSession) return;

			// TODO: If saveChanges is true, push file changes first
			if (saveChanges) {
				console.log("Pushing changes for session:", selectedSession.id);
				// In a real implementation, this would commit/push the changes
			}

			// Update session status to closed
			await api.updateSession(selectedSession.id, { status: "closed" });

			// Refresh workspaces to update the sidebar
			mutateWorkspaces();

			// Deselect the session
			setSelectedSession(null);
		},
		[selectedSession, mutateWorkspaces],
	);

	// Loading state
	if (workspacesLoading || agentsLoading) {
		return (
			<div className="h-screen flex items-center justify-center bg-background">
				<div className="text-muted-foreground">Loading...</div>
			</div>
		);
	}

	return (
		<div className="h-screen flex flex-col bg-background">
			<Header
				leftSidebarOpen={leftSidebarOpen}
				onToggleSidebar={() => setLeftSidebarOpen(!leftSidebarOpen)}
				onNewSession={handleNewSession}
				sessionAgent={sessionAgent}
				sessionWorkspace={sessionWorkspace}
				agentTypes={agentTypes}
				credentialsOpen={credentialsOpen}
				onCredentialsOpenChange={handleCredentialsOpenChange}
				credentialsInitialProviderId={credentialsInitialProviderId}
			/>

			<div className="flex-1 flex overflow-hidden">
				<LeftSidebar
					isOpen={leftSidebarOpen}
					workspaces={workspaces}
					agents={agents}
					agentTypes={agentTypes}
					selectedSessionId={selectedSession?.id || null}
					selectedAgentId={selectedAgent?.id || null}
					onSessionSelect={handleSessionSelect}
					onAgentSelect={setSelectedAgent}
					onAddWorkspace={dialogs.openWorkspaceDialog}
					onAddSession={handleAddSession}
					onAddAgent={() => dialogs.openAgentDialog()}
					onConfigureAgent={(agent) => dialogs.openAgentDialog(agent)}
				/>

				<MainContent
					selectedSession={selectedSession}
					workspaces={workspaces}
					agents={agents}
					agentTypes={agentTypes}
					preselectedWorkspaceId={preselectedWorkspaceId}
					workspaceSelectTrigger={workspaceSelectTrigger}
					selectedAgentId={selectedAgent?.id || null}
					onAddWorkspace={dialogs.openWorkspaceDialog}
					onAddAgent={() => dialogs.openAgentDialog()}
					onFirstMessage={handleFirstMessage}
					messages={messages}
					sessionAgent={sessionAgent}
					sessionWorkspace={sessionWorkspace}
					onCloseSession={handleCloseSession}
				/>
			</div>

			<AddWorkspaceDialog
				open={dialogs.showAddWorkspaceDialog}
				onOpenChange={dialogs.setShowAddWorkspaceDialog}
				onAdd={handleAddWorkspace}
			/>

			<AddAgentDialog
				open={dialogs.showAddAgentDialog}
				onOpenChange={dialogs.handleAgentDialogOpenChange}
				onAdd={handleAddOrEditAgent}
				editingAgent={dialogs.editingAgent}
				onOpenCredentials={openCredentialsForProvider}
				preselectedAgentTypeId={dialogs.preselectedAgentTypeId}
			/>

			<WelcomeModal
				open={!agentsLoading && agents.length === 0}
				agentTypes={agentTypes}
				onSelectAgentType={(agentType) =>
					dialogs.openAgentDialog(undefined, agentType.id)
				}
			/>
		</div>
	);
}
