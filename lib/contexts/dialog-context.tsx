"use client";

import * as React from "react";
import { api } from "@/lib/api-client";
import type {
	Agent,
	CreateAgentRequest,
	CreateWorkspaceRequest,
	StatusMessage,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useAuthProviders } from "@/lib/hooks/use-auth-providers";
import { useCredentials } from "@/lib/hooks/use-credentials";
import {
	type DialogControl,
	useDialogControl,
} from "@/lib/hooks/use-dialog-control";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";
import { useMainPanelContext } from "./main-panel-context";

// Dialog data types
interface AgentDialogData {
	agent?: Agent;
	agentTypeId?: string;
}

interface CredentialsDialogData {
	providerId?: string;
}

interface DialogContextValue {
	// Dialog controls
	workspaceDialog: DialogControl;
	agentDialog: DialogControl<AgentDialogData>;
	deleteWorkspaceDialog: DialogControl<Workspace>;
	credentialsDialog: DialogControl<CredentialsDialogData>;

	// System requirements (special case - driven by API response)
	systemRequirements: {
		isOpen: boolean;
		messages: StatusMessage[];
		close: () => void;
	};

	// Welcome modal state
	welcome: {
		skipped: boolean;
		setSkipped: (skipped: boolean) => void;
		systemStatusChecked: boolean;
		pendingAgentType: SupportedAgentType | null;
	};

	// Action handlers
	handleAddWorkspace: (data: CreateWorkspaceRequest) => Promise<void>;
	handleAddOrEditAgent: (data: CreateAgentRequest) => Promise<void>;
	handleConfirmDeleteWorkspace: (deleteFiles: boolean) => Promise<void>;
	handleWelcomeComplete: (
		agentType: SupportedAgentType,
		authProviderId: string | null,
		workspace: CreateWorkspaceRequest | null,
	) => Promise<void>;

	// Data for dialogs
	authProviders: ReturnType<typeof useAuthProviders>["authProviders"];
	credentials: ReturnType<typeof useCredentials>["credentials"];
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

export function useDialogContext() {
	const context = React.useContext(DialogContext);
	if (!context) {
		throw new Error("useDialogContext must be used within a DialogProvider");
	}
	return context;
}

interface DialogProviderProps {
	children: React.ReactNode;
}

export function DialogProvider({ children }: DialogProviderProps) {
	const mainPanel = useMainPanelContext();
	const workspace = useWorkspaces();
	const { createAgent, updateAgent, mutate: mutateAgents } = useAgents();
	const { agentTypes } = useAgentTypes();
	const { authProviders } = useAuthProviders();
	const { credentials } = useCredentials();

	// Dialog controls using the generic hook
	const workspaceDialog = useDialogControl();
	const agentDialog = useDialogControl<AgentDialogData>();
	const deleteWorkspaceDialog = useDialogControl<Workspace>();
	const credentialsDialog = useDialogControl<CredentialsDialogData>();

	// System status state (special case - populated by API)
	const [systemStatusChecked, setSystemStatusChecked] = React.useState(false);
	const [systemStatusMessages, setSystemStatusMessages] = React.useState<
		StatusMessage[]
	>([]);
	const [showSystemRequirements, setShowSystemRequirements] =
		React.useState(false);

	// Welcome modal state
	const [welcomeSkipped, setWelcomeSkipped] = React.useState(false);
	const [pendingAgentType, setPendingAgentType] =
		React.useState<SupportedAgentType | null>(null);

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

	// Action handlers
	const handleAddWorkspace = React.useCallback(
		async (data: CreateWorkspaceRequest) => {
			const ws = await workspace.createWorkspace(data);
			workspaceDialog.close();
			if (ws) {
				mainPanel.showNewSession({ workspaceId: ws.id });
			}
		},
		[workspace, mainPanel, workspaceDialog],
	);

	const handleAddOrEditAgent = React.useCallback(
		async (agentData: CreateAgentRequest) => {
			const editingAgent = agentDialog.data?.agent;
			if (editingAgent) {
				await updateAgent(editingAgent.id, agentData);
				mutateAgents();
			} else {
				await createAgent(agentData);
			}
			agentDialog.close();
		},
		[agentDialog, createAgent, updateAgent, mutateAgents],
	);

	const handleConfirmDeleteWorkspace = React.useCallback(
		async (deleteFiles: boolean) => {
			const ws = deleteWorkspaceDialog.data;
			if (!ws) return;

			await workspace.deleteWorkspace(ws.id, deleteFiles);

			// Check if current view is related to the deleted workspace
			const { view, selectedSession, showNewSession } = mainPanel;

			// Clear selection if viewing a session from the deleted workspace
			if (selectedSession?.workspaceId === ws.id) {
				showNewSession();
			}
			// Clear selection if new-session view has the deleted workspace preselected
			else if (view.type === "new-session" && view.workspaceId === ws.id) {
				showNewSession();
			}

			deleteWorkspaceDialog.close();
		},
		[deleteWorkspaceDialog, workspace, mainPanel],
	);

	const handleWelcomeComplete = React.useCallback(
		async (
			agentType: SupportedAgentType,
			authProviderId: string | null,
			workspaceData: CreateWorkspaceRequest | null,
		) => {
			if (authProviderId) {
				// Auth provider selected - store pending agent and open credentials dialog
				setPendingAgentType(agentType);
				credentialsDialog.open({ providerId: authProviderId });
				// If workspace was provided, create it after agent setup
				if (workspaceData) {
					await workspace.createWorkspace(workspaceData);
				}
			} else {
				// "Free" selected or already has credentials - create agent directly
				const newAgent = await createAgent({
					name: agentType.name,
					description: agentType.description,
					agentType: agentType.id,
				});
				// Make it the default agent
				await api.setDefaultAgent(newAgent.id);
				mutateAgents();
				// Create workspace if provided
				if (workspaceData) {
					const ws = await workspace.createWorkspace(workspaceData);
					if (ws) {
						mainPanel.showNewSession({ workspaceId: ws.id });
					}
				}
			}
		},
		[workspace, createAgent, mutateAgents, mainPanel, credentialsDialog],
	);

	const closeSystemRequirements = React.useCallback(() => {
		setShowSystemRequirements(false);
	}, []);

	const value = React.useMemo<DialogContextValue>(
		() => ({
			// Dialog controls
			workspaceDialog,
			agentDialog,
			deleteWorkspaceDialog,
			credentialsDialog,

			// System requirements
			systemRequirements: {
				isOpen: showSystemRequirements,
				messages: systemStatusMessages,
				close: closeSystemRequirements,
			},

			// Welcome modal
			welcome: {
				skipped: welcomeSkipped,
				setSkipped: setWelcomeSkipped,
				systemStatusChecked,
				pendingAgentType,
			},

			// Action handlers
			handleAddWorkspace,
			handleAddOrEditAgent,
			handleConfirmDeleteWorkspace,
			handleWelcomeComplete,

			// Data
			authProviders,
			credentials,
		}),
		[
			workspaceDialog,
			agentDialog,
			deleteWorkspaceDialog,
			credentialsDialog,
			showSystemRequirements,
			systemStatusMessages,
			closeSystemRequirements,
			welcomeSkipped,
			systemStatusChecked,
			pendingAgentType,
			handleAddWorkspace,
			handleAddOrEditAgent,
			handleConfirmDeleteWorkspace,
			handleWelcomeComplete,
			authProviders,
			credentials,
		],
	);

	return (
		<DialogContext.Provider value={value}>{children}</DialogContext.Provider>
	);
}
