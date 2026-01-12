"use client";

import * as React from "react";
import { AddAgentDialog } from "@/components/ide/add-agent-dialog";
import { AddWorkspaceDialog } from "@/components/ide/add-workspace-dialog";
import { Header, LeftSidebar, MainContent } from "@/components/ide/layout";
import { SystemRequirementsDialog } from "@/components/ide/system-requirements-dialog";
import { WelcomeModal } from "@/components/ide/welcome-modal";
import { api } from "@/lib/api-client";
import type {
	Agent,
	CreateAgentRequest,
	CreateWorkspaceRequest,
	Session,
	StatusMessage,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useAuthProviders } from "@/lib/hooks/use-auth-providers";
import { useCredentials } from "@/lib/hooks/use-credentials";
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

	// System status check
	const [systemStatusChecked, setSystemStatusChecked] = React.useState(false);
	const [systemStatusMessages, setSystemStatusMessages] = React.useState<
		StatusMessage[]
	>([]);
	const [showSystemRequirements, setShowSystemRequirements] =
		React.useState(false);

	// Check system status on mount
	React.useEffect(() => {
		async function checkSystemStatus() {
			try {
				const status = await api.getSystemStatus();
				if (status.messages && status.messages.length > 0) {
					setSystemStatusMessages(status.messages);
					setShowSystemRequirements(true);
				}
			} catch (error) {
				console.error("Failed to check system status:", error);
			} finally {
				setSystemStatusChecked(true);
			}
		}
		checkSystemStatus();
	}, []);

	// Data fetching
	const {
		workspaces,
		createWorkspace,
		deleteWorkspace,
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
	const { authProviders } = useAuthProviders();
	const { credentials } = useCredentials();
	const { messages } = useMessages(selectedSession?.id || null);

	// Dialog state
	const dialogs = useDialogState();
	const [credentialsOpen, setCredentialsOpen] = React.useState(false);
	const [credentialsInitialProviderId, setCredentialsInitialProviderId] =
		React.useState<string | null>(null);
	// Track pending agent type when user needs to configure credentials first
	const [pendingAgentType, setPendingAgentType] =
		React.useState<SupportedAgentType | null>(null);

	// Handle credentials dialog close - create pending agent if credentials were configured
	const handleCredentialsOpenChange = React.useCallback(
		async (open: boolean) => {
			setCredentialsOpen(open);
			if (!open) {
				setCredentialsInitialProviderId(null);
				// If we have a pending agent type from welcome modal, create it now
				if (pendingAgentType) {
					const agentType = pendingAgentType;
					setPendingAgentType(null);
					try {
						const agent = await createAgent({
							name: agentType.name,
							description: agentType.description,
							agentType: agentType.id,
						});
						await api.setDefaultAgent(agent.id);
						mutateAgents();
					} catch (error) {
						console.error("Failed to create agent:", error);
					}
				}
			}
		},
		[pendingAgentType, createAgent, mutateAgents],
	);

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

	// Handle workspace selection from breadcrumb dropdown
	const handleWorkspaceSelect = React.useCallback((workspace: Workspace) => {
		// Find first non-closed session in this workspace
		const firstSession = workspace.sessions.find((s) => s.status !== "closed");
		if (firstSession) {
			setSelectedSession(firstSession);
		} else {
			// No open sessions - clear selection and preselect this workspace for new session
			setSelectedSession(null);
			setPreselectedWorkspaceId(workspace.id);
		}
	}, []);

	const handleAddWorkspace = async (newWorkspace: CreateWorkspaceRequest) => {
		const workspace = await createWorkspace(newWorkspace);
		dialogs.closeWorkspaceDialog();
		// Auto-select the newly created workspace
		if (workspace) {
			setPreselectedWorkspaceId(workspace.id);
			setWorkspaceSelectTrigger((prev) => prev + 1);
		}
	};

	const handleDeleteWorkspace = async (workspaceId: string) => {
		await deleteWorkspace(workspaceId);
		// Clear selection if the deleted workspace was preselected
		if (preselectedWorkspaceId === workspaceId) {
			setPreselectedWorkspaceId(null);
		}
		// Clear session if it belonged to the deleted workspace
		if (selectedSession?.workspaceId === workspaceId) {
			setSelectedSession(null);
		}
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
				workspaces={workspaces}
				selectedSession={selectedSession}
				sessionAgent={sessionAgent}
				sessionWorkspace={sessionWorkspace}
				agentTypes={agentTypes}
				onWorkspaceSelect={handleWorkspaceSelect}
				onSessionSelect={handleSessionSelect}
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
					onDeleteWorkspace={handleDeleteWorkspace}
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

			<SystemRequirementsDialog
				open={showSystemRequirements}
				messages={systemStatusMessages}
				onClose={() => setShowSystemRequirements(false)}
			/>

			<WelcomeModal
				open={
					systemStatusChecked &&
					!showSystemRequirements &&
					!agentsLoading &&
					agents.length === 0
				}
				agentTypes={agentTypes}
				authProviders={authProviders}
				configuredCredentials={credentials}
				onComplete={async (agentType, authProviderId) => {
					if (authProviderId) {
						// Auth provider selected - store pending agent and open credentials dialog
						// Agent will be created automatically when credentials are configured
						setPendingAgentType(agentType);
						openCredentialsForProvider(authProviderId);
					} else {
						// "Free" selected or already has credentials - create agent directly and make it default
						const agent = await createAgent({
							name: agentType.name,
							description: agentType.description,
							agentType: agentType.id,
						});
						// Make it the default agent
						await api.setDefaultAgent(agent.id);
						mutateAgents();
					}
				}}
			/>
		</div>
	);
}
