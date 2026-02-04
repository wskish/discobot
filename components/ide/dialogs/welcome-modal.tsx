import { Key } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type {
	Agent,
	AuthProvider,
	CreateWorkspaceRequest,
	CredentialInfo,
	SupportedAgentType,
} from "@/lib/api-types";
import { STORAGE_KEYS } from "@/lib/hooks/use-persisted-state";
import { DiscobotBrand } from "../discobot-brand";
import { DiscobotLogo } from "../discobot-logo";
import { WorkspaceForm, type WorkspaceFormRef } from "../workspace-form";

interface WelcomeModalProps {
	open: boolean;
	agentTypes: SupportedAgentType[];
	authProviders: AuthProvider[];
	configuredCredentials: CredentialInfo[];
	existingAgents: Agent[];
	hasExistingWorkspaces: boolean;
	onComplete: (
		needsCredential: boolean,
		workspace: CreateWorkspaceRequest | null,
	) => void;
	onSkip?: () => void;
}

/**
 * Simple onboarding modal for Claude Code:
 * 1. Auto-create Claude Code agent if none exists
 * 2. If no credential, show prompt to configure it
 * 3. If no workspace, show workspace form
 */
export function WelcomeModal({
	open,
	agentTypes,
	configuredCredentials,
	existingAgents,
	hasExistingWorkspaces,
	onComplete,
	onSkip,
}: WelcomeModalProps) {
	const [workspaceIsValid, setWorkspaceIsValid] = React.useState(false);
	const [initialWorkspacePath, setInitialWorkspacePath] = React.useState<
		string | undefined
	>(undefined);
	const workspaceFormRef = React.useRef<WorkspaceFormRef>(null);

	// Find Claude Code agent type
	const claudeCodeAgentType = React.useMemo(
		() => agentTypes.find((a) => a.id === "claude-code"),
		[agentTypes],
	);

	// Check if we have a Claude Code agent
	const hasClaudeCodeAgent = existingAgents.length > 0;

	// Check if we have Anthropic credentials configured
	const hasAnthropicCredential = React.useMemo(() => {
		return configuredCredentials.some(
			(c) => c.isConfigured && c.provider === "anthropic",
		);
	}, [configuredCredentials]);

	// Determine what we need
	const needsCredential = !hasAnthropicCredential;
	const needsWorkspace = !hasExistingWorkspaces;

	// Track if we've already initialized to prevent infinite loops
	const hasInitialized = React.useRef(false);

	// Initialize workspace path from localStorage
	React.useEffect(() => {
		if (!open) {
			hasInitialized.current = false;
			return;
		}

		try {
			const storedPath = localStorage.getItem(STORAGE_KEYS.LAST_WORKSPACE_PATH);
			setInitialWorkspacePath(storedPath ?? undefined);
		} catch {
			setInitialWorkspacePath(undefined);
		}
	}, [open]);

	// Auto-create Claude Code agent if it doesn't exist AND has credentials (once per modal open)
	React.useEffect(() => {
		if (
			!open ||
			!claudeCodeAgentType ||
			hasClaudeCodeAgent ||
			hasInitialized.current
		)
			return;

		// Only auto-create if credentials already exist (don't trigger credential dialog)
		if (!needsCredential) {
			hasInitialized.current = true;
			onComplete(false, null);
		}
	}, [
		open,
		claudeCodeAgentType,
		hasClaudeCodeAgent,
		needsCredential,
		onComplete,
	]);

	const handleConfigureCredential = () => {
		// Signal that we need to configure credential
		onComplete(true, null);
	};

	const handleWorkspaceSubmit = (workspace: CreateWorkspaceRequest) => {
		try {
			localStorage.setItem(STORAGE_KEYS.LAST_WORKSPACE_PATH, workspace.path);
		} catch {
			// Ignore errors
		}
		onComplete(false, workspace);
	};

	const handleSkipWorkspace = () => {
		onComplete(false, null);
	};

	// If everything is set up, close immediately
	if (!needsCredential && !needsWorkspace) {
		return null;
	}

	// Show credential configuration prompt
	if (needsCredential) {
		return (
			<Dialog open={open}>
				<DialogContent
					className="sm:max-w-md p-0 gap-0 overflow-hidden"
					showCloseButton={false}
				>
					{/* Header */}
					<div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-8 py-10 text-center">
						<div className="flex justify-center mb-4">
							<DiscobotLogo size={64} className="text-purple-500" />
						</div>

						<DialogHeader className="space-y-3">
							<DialogTitle className="text-3xl tracking-tight flex items-center justify-center">
								<span className="font-semibold">Welcome to</span>
								<DiscobotBrand logoSize={0} textSize="text-3xl" />
							</DialogTitle>
							<DialogDescription className="text-base text-muted-foreground max-w-md mx-auto">
								To get started, you need to configure your Claude Code
								credential.
							</DialogDescription>
						</DialogHeader>
					</div>

					{/* Content */}
					<div className="px-8 py-6 space-y-6">
						<div className="flex flex-col items-center gap-4">
							<div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
								<Key className="h-8 w-8 text-primary" />
							</div>
							<div className="text-center space-y-2">
								<h3 className="font-semibold text-lg">Configure Claude Code</h3>
								<p className="text-sm text-muted-foreground">
									Click below to set up your Anthropic API key
								</p>
							</div>
							<Button onClick={handleConfigureCredential} size="lg">
								Configure Credential
							</Button>
						</div>

						{onSkip && (
							<div className="flex justify-center pt-2 border-t border-border">
								<Button
									variant="ghost"
									onClick={onSkip}
									className="text-muted-foreground"
								>
									Skip for now
								</Button>
							</div>
						)}
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	// Show workspace form
	return (
		<Dialog open={open}>
			<DialogContent
				className="sm:max-w-2xl p-0 gap-0 overflow-hidden max-h-[90vh] flex flex-col"
				showCloseButton={false}
			>
				{/* Header */}
				<div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-8 py-10 text-center flex-shrink-0">
					<div className="flex justify-center mb-4">
						<DiscobotLogo size={64} className="text-purple-500" />
					</div>

					<DialogHeader className="space-y-3">
						<DialogTitle className="text-3xl tracking-tight flex items-center justify-center">
							<span className="font-semibold">Welcome to</span>
							<DiscobotBrand logoSize={0} textSize="text-3xl" />
						</DialogTitle>
						<DialogDescription className="text-base text-muted-foreground max-w-md mx-auto">
							Add a workspace to start coding. You can add a local folder or
							clone a git repository.
						</DialogDescription>
					</DialogHeader>
				</div>

				{/* Content */}
				<div className="px-8 py-6 space-y-6 flex-1 overflow-y-auto">
					<div className="space-y-3">
						<h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
							Workspace
						</h3>
						<WorkspaceForm
							ref={workspaceFormRef}
							onSubmit={handleWorkspaceSubmit}
							onValidationChange={setWorkspaceIsValid}
							initialValue={initialWorkspacePath}
						/>
					</div>

					<div className="flex justify-end gap-3 pt-2 border-t border-border">
						<Button
							variant="ghost"
							onClick={onSkip || handleSkipWorkspace}
							className="text-muted-foreground"
						>
							Skip for now
						</Button>
						<Button
							onClick={() => workspaceFormRef.current?.submit()}
							disabled={!workspaceIsValid}
						>
							Add Workspace
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
