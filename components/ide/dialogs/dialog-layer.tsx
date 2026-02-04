import * as React from "react";
import { lazy, Suspense } from "react";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";

// Lazy load dialogs - not needed on initial render
const AddWorkspaceDialog = lazy(() =>
	import("./add-workspace-dialog").then((m) => ({
		default: m.AddWorkspaceDialog,
	})),
);

const AddAgentDialog = lazy(() =>
	import("./add-agent-dialog").then((m) => ({ default: m.AddAgentDialog })),
);

const DeleteWorkspaceDialog = lazy(() =>
	import("./delete-workspace-dialog").then((m) => ({
		default: m.DeleteWorkspaceDialog,
	})),
);

const CredentialsDialog = lazy(() =>
	import("./credentials-dialog").then((m) => ({
		default: m.CredentialsDialog,
	})),
);

const SystemRequirementsDialog = lazy(() =>
	import("./system-requirements-dialog").then((m) => ({
		default: m.SystemRequirementsDialog,
	})),
);

const WelcomeModal = lazy(() =>
	import("./welcome-modal").then((m) => ({ default: m.WelcomeModal })),
);

export function DialogLayer() {
	const { workspaces } = useWorkspaces();
	const { agents, isLoading: agentsLoading } = useAgents();
	const { agentTypes } = useAgentTypes();
	const dialogs = useDialogContext();

	// Simple check: show welcome if no agents OR no Anthropic credentials OR no workspaces
	const hasAnthropicCredential = React.useMemo(() => {
		return dialogs.credentials.some(
			(c) => c.isConfigured && c.provider === "anthropic",
		);
	}, [dialogs.credentials]);

	const needsOnboarding =
		agents.length === 0 || !hasAnthropicCredential || workspaces.length === 0;

	return (
		<>
			<Suspense fallback={null}>
				<AddWorkspaceDialog
					open={dialogs.workspaceDialog.isOpen}
					onOpenChange={dialogs.workspaceDialog.onOpenChange}
					onAdd={dialogs.handleAddWorkspace}
				/>
			</Suspense>

			<Suspense fallback={null}>
				<AddAgentDialog
					open={dialogs.agentDialog.isOpen}
					onOpenChange={dialogs.agentDialog.onOpenChange}
					onAdd={dialogs.handleAddOrEditAgent}
					editingAgent={dialogs.agentDialog.data?.agent}
					onOpenCredentials={(providerId) =>
						dialogs.credentialsDialog.open({ providerId })
					}
					preselectedAgentTypeId={dialogs.agentDialog.data?.agentTypeId}
				/>
			</Suspense>

			<Suspense fallback={null}>
				<DeleteWorkspaceDialog
					open={dialogs.deleteWorkspaceDialog.isOpen}
					onOpenChange={dialogs.deleteWorkspaceDialog.onOpenChange}
					workspace={dialogs.deleteWorkspaceDialog.data}
					onConfirm={dialogs.handleConfirmDeleteWorkspace}
				/>
			</Suspense>

			<Suspense fallback={null}>
				<CredentialsDialog
					open={dialogs.credentialsDialog.isOpen}
					onOpenChange={dialogs.credentialsDialog.onOpenChange}
					initialProviderId={dialogs.credentialsDialog.data?.providerId}
				/>
			</Suspense>

			<Suspense fallback={null}>
				<SystemRequirementsDialog
					open={dialogs.systemRequirements.isOpen}
					messages={dialogs.systemRequirements.messages}
					onClose={dialogs.systemRequirements.close}
				/>
			</Suspense>

			<Suspense fallback={null}>
				<WelcomeModal
					open={
						dialogs.welcome.systemStatusChecked &&
						!dialogs.systemRequirements.isOpen &&
						!agentsLoading &&
						needsOnboarding &&
						!dialogs.welcome.skipped
					}
					agentTypes={agentTypes}
					authProviders={dialogs.authProviders}
					configuredCredentials={dialogs.credentials}
					existingAgents={agents}
					hasExistingWorkspaces={workspaces.length > 0}
					onSkip={() => dialogs.welcome.setSkipped(true)}
					onComplete={dialogs.handleWelcomeComplete}
				/>
			</Suspense>
		</>
	);
}
