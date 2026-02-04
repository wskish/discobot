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
import { useMainContentContext } from "./main-content-context";

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
		needsCredential: boolean,
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
	const mainPanel = useMainContentContext();
	const workspace = useWorkspaces();
	const { createAgent, updateAgent, mutate: mutateAgents } = useAgents();
	useAgentTypes(); // Preload agent types for dialog
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
	const [pendingAgentType] = React.useState<SupportedAgentType | null>(null);

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
			needsCredential: boolean,
			workspaceData: CreateWorkspaceRequest | null,
		) => {
			// If we need credentials, open the credentials dialog for Anthropic
			if (needsCredential) {
				credentialsDialog.open({ providerId: "anthropic" });
				return;
			}

			// Create workspace if provided
			if (workspaceData) {
				const ws = await workspace.createWorkspace(workspaceData);
				if (ws) {
					mainPanel.showNewSession({ workspaceId: ws.id });
				}
			}
		},
		[workspace, mainPanel, credentialsDialog],
	);

	const closeSystemRequirements = React.useCallback(() => {
		setShowSystemRequirements(false);
	}, []);

	// Monitor credentials - when Anthropic credentials are created, auto-create Claude Code agent
	const prevCredentialsCount = React.useRef(credentials.length);
	const agentCreationInProgress = React.useRef(false);
	const { agents } = useAgents();

	React.useEffect(() => {
		// Skip if agent creation already in progress or agents already exist
		if (agentCreationInProgress.current || agents.length > 0) return;

		// Skip if credentials count hasn't changed (no new credentials)
		if (credentials.length === prevCredentialsCount.current) return;

		prevCredentialsCount.current = credentials.length;

		// Check if we now have Anthropic credentials
		const hasAnthropicCredential = credentials.some(
			(c) => c.isConfigured && c.provider === "anthropic",
		);

		if (hasAnthropicCredential) {
			// Credentials were successfully created - now create Claude Code agent automatically
			agentCreationInProgress.current = true;

			(async () => {
				try {
					const newAgent = await createAgent({
						name: "Claude Code",
						description: "AI coding agent powered by Claude",
						agentType: "claude-code",
					});
					await api.setDefaultAgent(newAgent.id);
					await mutateAgents();

					// Close credentials dialog if still open
					if (credentialsDialog.isOpen) {
						credentialsDialog.close();
					}

					// Welcome modal will automatically reopen for workspace step if needed
				} catch (error) {
					console.error(
						"Failed to create Claude Code agent after credentials setup:",
						error,
					);
				} finally {
					agentCreationInProgress.current = false;
				}
			})();
		}
	}, [
		credentials,
		agents.length,
		createAgent,
		mutateAgents,
		credentialsDialog,
	]);

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
