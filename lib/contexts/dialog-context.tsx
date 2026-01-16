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
import { useAuthProviders } from "@/lib/hooks/use-auth-providers";
import { useCredentials } from "@/lib/hooks/use-credentials";
import { useSessionContext } from "./session-context";

interface DialogContextValue {
	// Workspace dialog
	showAddWorkspaceDialog: boolean;
	openWorkspaceDialog: () => void;
	closeWorkspaceDialog: () => void;
	handleAddWorkspace: (data: CreateWorkspaceRequest) => Promise<void>;

	// Agent dialog
	showAddAgentDialog: boolean;
	editingAgent: Agent | null;
	preselectedAgentTypeId: string | null;
	openAgentDialog: (agent?: Agent, agentTypeId?: string) => void;
	closeAgentDialog: () => void;
	handleAgentDialogOpenChange: (open: boolean) => void;
	handleAddOrEditAgent: (data: CreateAgentRequest) => Promise<void>;

	// Delete workspace dialog
	deleteWorkspaceDialogOpen: boolean;
	workspaceToDelete: Workspace | null;
	openDeleteWorkspaceDialog: (workspace: Workspace) => void;
	closeDeleteWorkspaceDialog: () => void;
	handleConfirmDeleteWorkspace: (deleteFiles: boolean) => Promise<void>;

	// Credentials dialog
	credentialsDialogOpen: boolean;
	credentialsInitialProviderId: string | null;
	openCredentialsForProvider: (providerId?: string) => void;
	closeCredentialsDialog: () => void;

	// System requirements dialog
	showSystemRequirements: boolean;
	systemStatusMessages: StatusMessage[];
	closeSystemRequirements: () => void;

	// Welcome modal
	welcomeSkipped: boolean;
	setWelcomeSkipped: (skipped: boolean) => void;
	systemStatusChecked: boolean;
	handleWelcomeComplete: (
		agentType: SupportedAgentType,
		authProviderId: string | null,
		workspace: CreateWorkspaceRequest | null,
	) => Promise<void>;

	// Data for dialogs
	authProviders: ReturnType<typeof useAuthProviders>["authProviders"];
	credentials: ReturnType<typeof useCredentials>["credentials"];

	// Pending agent type (for credentials flow)
	pendingAgentType: SupportedAgentType | null;
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
	const session = useSessionContext();
	const { authProviders } = useAuthProviders();
	const { credentials } = useCredentials();

	// Workspace dialog state
	const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] =
		React.useState(false);

	// Agent dialog state
	const [showAddAgentDialog, setShowAddAgentDialog] = React.useState(false);
	const [editingAgent, setEditingAgent] = React.useState<Agent | null>(null);
	const [preselectedAgentTypeId, setPreselectedAgentTypeId] = React.useState<
		string | null
	>(null);

	// Delete workspace dialog state
	const [deleteWorkspaceDialogOpen, setDeleteWorkspaceDialogOpen] =
		React.useState(false);
	const [workspaceToDelete, setWorkspaceToDelete] =
		React.useState<Workspace | null>(null);

	// Credentials dialog state
	const [credentialsDialogOpen, setCredentialsDialogOpen] =
		React.useState(false);
	const [credentialsInitialProviderId, setCredentialsInitialProviderId] =
		React.useState<string | null>(null);

	// System status state
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

	// Workspace dialog actions
	const openWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(true);
	}, []);

	const closeWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(false);
	}, []);

	const handleAddWorkspace = React.useCallback(
		async (data: CreateWorkspaceRequest) => {
			const workspace = await session.createWorkspace(data);
			setShowAddWorkspaceDialog(false);
			if (workspace) {
				session.handleAddSession(workspace.id);
			}
		},
		[session],
	);

	// Agent dialog actions
	const openAgentDialog = React.useCallback(
		(agent?: Agent, agentTypeId?: string) => {
			setEditingAgent(agent || null);
			setPreselectedAgentTypeId(agentTypeId || null);
			setShowAddAgentDialog(true);
		},
		[],
	);

	const closeAgentDialog = React.useCallback(() => {
		setEditingAgent(null);
		setPreselectedAgentTypeId(null);
		setShowAddAgentDialog(false);
	}, []);

	const handleAgentDialogOpenChange = React.useCallback((open: boolean) => {
		if (!open) {
			setEditingAgent(null);
			setPreselectedAgentTypeId(null);
		}
		setShowAddAgentDialog(open);
	}, []);

	const handleAddOrEditAgent = React.useCallback(
		async (agentData: CreateAgentRequest) => {
			if (editingAgent) {
				await session.updateAgent(editingAgent.id, agentData);
				session.mutateAgents();
			} else {
				const agent = await session.createAgent(agentData);
				if (agent) {
					session.selectAgent(agent.id);
				}
			}
			setEditingAgent(null);
			setPreselectedAgentTypeId(null);
			setShowAddAgentDialog(false);
		},
		[editingAgent, session],
	);

	// Delete workspace dialog actions
	const openDeleteWorkspaceDialog = React.useCallback(
		(workspace: Workspace) => {
			setWorkspaceToDelete(workspace);
			setDeleteWorkspaceDialogOpen(true);
		},
		[],
	);

	const closeDeleteWorkspaceDialog = React.useCallback(() => {
		setDeleteWorkspaceDialogOpen(false);
		setWorkspaceToDelete(null);
	}, []);

	const handleConfirmDeleteWorkspace = React.useCallback(
		async (deleteFiles: boolean) => {
			if (!workspaceToDelete) return;

			const workspaceId = workspaceToDelete.id;
			await session.deleteWorkspace(workspaceId, deleteFiles);

			// Clear selection if the deleted workspace was preselected
			if (session.preselectedWorkspaceId === workspaceId) {
				session.handleNewSession();
			}
			// Clear session if it belonged to the deleted workspace
			if (session.selectedSession?.workspaceId === workspaceId) {
				session.selectSession(null);
			}

			setDeleteWorkspaceDialogOpen(false);
			setWorkspaceToDelete(null);
		},
		[workspaceToDelete, session],
	);

	// Credentials dialog actions
	const openCredentialsForProvider = React.useCallback(
		(providerId?: string) => {
			setCredentialsInitialProviderId(providerId ?? null);
			setCredentialsDialogOpen(true);
		},
		[],
	);

	const closeCredentialsDialog = React.useCallback(() => {
		setCredentialsDialogOpen(false);
		setCredentialsInitialProviderId(null);
	}, []);

	// System requirements actions
	const closeSystemRequirements = React.useCallback(() => {
		setShowSystemRequirements(false);
	}, []);

	// Welcome modal complete handler
	const handleWelcomeComplete = React.useCallback(
		async (
			agentType: SupportedAgentType,
			authProviderId: string | null,
			workspace: CreateWorkspaceRequest | null,
		) => {
			if (authProviderId) {
				// Auth provider selected - store pending agent and open credentials dialog
				setPendingAgentType(agentType);
				setCredentialsInitialProviderId(authProviderId);
				setCredentialsDialogOpen(true);
				// If workspace was provided, create it after agent setup
				if (workspace) {
					await session.createWorkspace(workspace);
				}
			} else {
				// "Free" selected or already has credentials - create agent directly
				const agent = await session.createAgent({
					name: agentType.name,
					description: agentType.description,
					agentType: agentType.id,
				});
				// Make it the default agent
				await api.setDefaultAgent(agent.id);
				session.mutateAgents();
				// Create workspace if provided
				if (workspace) {
					const ws = await session.createWorkspace(workspace);
					if (ws) {
						session.handleAddSession(ws.id);
					}
				}
			}
		},
		[session],
	);

	const value = React.useMemo<DialogContextValue>(
		() => ({
			// Workspace dialog
			showAddWorkspaceDialog,
			openWorkspaceDialog,
			closeWorkspaceDialog,
			handleAddWorkspace,

			// Agent dialog
			showAddAgentDialog,
			editingAgent,
			preselectedAgentTypeId,
			openAgentDialog,
			closeAgentDialog,
			handleAgentDialogOpenChange,
			handleAddOrEditAgent,

			// Delete workspace dialog
			deleteWorkspaceDialogOpen,
			workspaceToDelete,
			openDeleteWorkspaceDialog,
			closeDeleteWorkspaceDialog,
			handleConfirmDeleteWorkspace,

			// Credentials dialog
			credentialsDialogOpen,
			credentialsInitialProviderId,
			openCredentialsForProvider,
			closeCredentialsDialog,

			// System requirements
			showSystemRequirements,
			systemStatusMessages,
			closeSystemRequirements,

			// Welcome modal
			welcomeSkipped,
			setWelcomeSkipped,
			systemStatusChecked,
			handleWelcomeComplete,

			// Data
			authProviders,
			credentials,
			pendingAgentType,
		}),
		[
			showAddWorkspaceDialog,
			openWorkspaceDialog,
			closeWorkspaceDialog,
			handleAddWorkspace,
			showAddAgentDialog,
			editingAgent,
			preselectedAgentTypeId,
			openAgentDialog,
			closeAgentDialog,
			handleAgentDialogOpenChange,
			handleAddOrEditAgent,
			deleteWorkspaceDialogOpen,
			workspaceToDelete,
			openDeleteWorkspaceDialog,
			closeDeleteWorkspaceDialog,
			handleConfirmDeleteWorkspace,
			credentialsDialogOpen,
			credentialsInitialProviderId,
			openCredentialsForProvider,
			closeCredentialsDialog,
			showSystemRequirements,
			systemStatusMessages,
			closeSystemRequirements,
			welcomeSkipped,
			systemStatusChecked,
			handleWelcomeComplete,
			authProviders,
			credentials,
			pendingAgentType,
		],
	);

	return (
		<DialogContext.Provider value={value}>{children}</DialogContext.Provider>
	);
}
