"use client";

import dynamic from "next/dynamic";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useSessionContext } from "@/lib/contexts/session-context";

// Dynamic imports for dialogs - not needed on initial render
const AddWorkspaceDialog = dynamic(
	() =>
		import("@/components/ide/add-workspace-dialog").then(
			(m) => m.AddWorkspaceDialog,
		),
	{ ssr: false },
);

const AddAgentDialog = dynamic(
	() =>
		import("@/components/ide/add-agent-dialog").then((m) => m.AddAgentDialog),
	{ ssr: false },
);

const DeleteWorkspaceDialog = dynamic(
	() =>
		import("@/components/ide/delete-workspace-dialog").then(
			(m) => m.DeleteWorkspaceDialog,
		),
	{ ssr: false },
);

const CredentialsDialog = dynamic(
	() =>
		import("@/components/ide/credentials-dialog").then(
			(m) => m.CredentialsDialog,
		),
	{ ssr: false },
);

const SystemRequirementsDialog = dynamic(
	() =>
		import("@/components/ide/system-requirements-dialog").then(
			(m) => m.SystemRequirementsDialog,
		),
	{ ssr: false },
);

const WelcomeModal = dynamic(
	() => import("@/components/ide/welcome-modal").then((m) => m.WelcomeModal),
	{ ssr: false },
);

export function DialogLayer() {
	const session = useSessionContext();
	const dialogs = useDialogContext();

	return (
		<>
			<AddWorkspaceDialog
				open={dialogs.showAddWorkspaceDialog}
				onOpenChange={(open) => {
					if (!open) dialogs.closeWorkspaceDialog();
				}}
				onAdd={dialogs.handleAddWorkspace}
			/>

			<AddAgentDialog
				open={dialogs.showAddAgentDialog}
				onOpenChange={dialogs.handleAgentDialogOpenChange}
				onAdd={dialogs.handleAddOrEditAgent}
				editingAgent={dialogs.editingAgent}
				onOpenCredentials={dialogs.openCredentialsForProvider}
				preselectedAgentTypeId={dialogs.preselectedAgentTypeId}
			/>

			<DeleteWorkspaceDialog
				open={dialogs.deleteWorkspaceDialogOpen}
				onOpenChange={(open) => {
					if (!open) dialogs.closeDeleteWorkspaceDialog();
				}}
				workspace={dialogs.workspaceToDelete}
				onConfirm={dialogs.handleConfirmDeleteWorkspace}
			/>

			<CredentialsDialog
				open={dialogs.credentialsDialogOpen}
				onOpenChange={(open) => {
					if (!open) dialogs.closeCredentialsDialog();
				}}
				initialProviderId={dialogs.credentialsInitialProviderId}
			/>

			<SystemRequirementsDialog
				open={dialogs.showSystemRequirements}
				messages={dialogs.systemStatusMessages}
				onClose={dialogs.closeSystemRequirements}
			/>

			<WelcomeModal
				open={
					dialogs.systemStatusChecked &&
					!dialogs.showSystemRequirements &&
					!session.agentsLoading &&
					session.agents.length === 0 &&
					!dialogs.welcomeSkipped
				}
				agentTypes={session.agentTypes}
				authProviders={dialogs.authProviders}
				configuredCredentials={dialogs.credentials}
				hasExistingWorkspaces={session.workspaces.length > 0}
				onSkip={() => dialogs.setWelcomeSkipped(true)}
				onComplete={dialogs.handleWelcomeComplete}
			/>
		</>
	);
}
