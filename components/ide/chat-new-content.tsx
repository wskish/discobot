import * as React from "react";
import {
	WelcomeHeader,
	WelcomeSelectors,
} from "@/components/ide/welcome-animation";
import type { Agent, Icon } from "@/lib/api-types";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";

interface ChatNewContentProps {
	/** Whether to show the welcome UI */
	show: boolean;
	/** Initial workspace ID (from context, passed down as prop) */
	initialWorkspaceId: string | null;
	/** Callback when workspace selection changes */
	onWorkspaceChange: (workspaceId: string | null) => void;
	/** Callback when agent selection changes */
	onAgentChange: (agentId: string | null) => void;
}

/**
 * ChatNewContent - Welcome UI for new chat sessions
 * Shows animated header and workspace/agent selectors
 * Only rendered when starting a new session (isNew prop)
 */
export function ChatNewContent({
	show,
	initialWorkspaceId,
	onWorkspaceChange,
	onAgentChange,
}: ChatNewContentProps) {
	const { agentDialog, workspaceDialog, handleAddWorkspace } =
		useDialogContext();
	const { workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces();
	const { agents, isLoading: isLoadingAgents } = useAgents();
	const { agentTypes } = useAgentTypes();

	// Persist agent ID selection in localStorage (component-local state)
	const [localSelectedAgentId, setLocalSelectedAgentId] = usePersistedState<
		string | null
	>(STORAGE_KEYS.SELECTED_AGENT_ID, null);

	// Initialize workspace state from prop
	const [localSelectedWorkspaceId, setLocalSelectedWorkspaceId] =
		React.useState<string | null>(initialWorkspaceId);

	// Track loading state for sample workspace creation
	const [isCreatingSampleWorkspace, setIsCreatingSampleWorkspace] =
		React.useState(false);

	// Track if we've notified parent of initial selections
	const hasNotifiedWorkspaceRef = React.useRef(false);
	const hasNotifiedAgentRef = React.useRef(false);

	// Track the previous initialWorkspaceId to detect when it changes (navigation)
	const prevInitialWorkspaceIdRef = React.useRef(initialWorkspaceId);

	// Sync workspace with initial value only when initialWorkspaceId changes (not when local state changes)
	React.useEffect(() => {
		if (
			initialWorkspaceId &&
			initialWorkspaceId !== prevInitialWorkspaceIdRef.current
		) {
			prevInitialWorkspaceIdRef.current = initialWorkspaceId;
			setLocalSelectedWorkspaceId(initialWorkspaceId);
			onWorkspaceChange(initialWorkspaceId);
			hasNotifiedWorkspaceRef.current = true;
		}
	}, [initialWorkspaceId, onWorkspaceChange]);

	// Notify parent of initial workspace selection (from prop or auto-select)
	React.useEffect(() => {
		if (hasNotifiedWorkspaceRef.current) return;

		// If we have a workspace selected and workspaces are loaded
		if (localSelectedWorkspaceId && workspaces.length > 0) {
			const workspaceExists = workspaces.some(
				(ws) => ws.id === localSelectedWorkspaceId,
			);

			if (workspaceExists) {
				// Notify parent of the current selection
				onWorkspaceChange(localSelectedWorkspaceId);
				hasNotifiedWorkspaceRef.current = true;
			} else if (!initialWorkspaceId) {
				// Workspace doesn't exist and wasn't explicitly requested via navigation,
				// fall back to first (e.g. persisted ID from a deleted workspace)
				const workspaceToSelect = workspaces[0];
				setLocalSelectedWorkspaceId(workspaceToSelect.id);
				onWorkspaceChange(workspaceToSelect.id);
				hasNotifiedWorkspaceRef.current = true;
			}
			// If initialWorkspaceId is set but not in the list yet, wait for
			// the workspace list to update (e.g. after creating a new workspace)
		} else if (!localSelectedWorkspaceId && workspaces.length > 0) {
			// No workspace selected, auto-select first
			const workspaceToSelect = workspaces[0];
			setLocalSelectedWorkspaceId(workspaceToSelect.id);
			onWorkspaceChange(workspaceToSelect.id);
			hasNotifiedWorkspaceRef.current = true;
		}
	}, [
		localSelectedWorkspaceId,
		workspaces,
		initialWorkspaceId,
		onWorkspaceChange,
	]);

	// Handle workspace deletion after initial notification
	React.useEffect(() => {
		if (!hasNotifiedWorkspaceRef.current) return;
		if (!localSelectedWorkspaceId) return;

		// Check if currently selected workspace still exists
		const workspaceExists = workspaces.some(
			(ws) => ws.id === localSelectedWorkspaceId,
		);

		if (!workspaceExists && workspaces.length > 0) {
			// Current workspace was deleted, fall back to first
			const workspaceToSelect = workspaces[0];
			setLocalSelectedWorkspaceId(workspaceToSelect.id);
			onWorkspaceChange(workspaceToSelect.id);
		}
	}, [localSelectedWorkspaceId, workspaces, onWorkspaceChange]);

	// Notify parent of initial agent selection (from persistent storage or auto-select)
	React.useEffect(() => {
		if (hasNotifiedAgentRef.current) return;

		// If we have an agent selected and agents are loaded
		if (localSelectedAgentId && agents.length > 0) {
			const agentExists = agents.some((a) => a.id === localSelectedAgentId);

			if (agentExists) {
				// Notify parent of the current selection (from persistent storage)
				onAgentChange(localSelectedAgentId);
				hasNotifiedAgentRef.current = true;
			} else {
				// Agent doesn't exist, fall back to default or first
				const defaultAgent = agents.find((a) => a.isDefault);
				const agentToSelect = defaultAgent || agents[0];
				if (agentToSelect) {
					setLocalSelectedAgentId(agentToSelect.id);
					onAgentChange(agentToSelect.id);
					hasNotifiedAgentRef.current = true;
				}
			}
		} else if (!localSelectedAgentId && agents.length > 0) {
			// No agent selected, auto-select default or first
			const defaultAgent = agents.find((a) => a.isDefault);
			const agentToSelect = defaultAgent || agents[0];
			if (agentToSelect) {
				setLocalSelectedAgentId(agentToSelect.id);
				onAgentChange(agentToSelect.id);
				hasNotifiedAgentRef.current = true;
			}
		}
	}, [localSelectedAgentId, agents, onAgentChange, setLocalSelectedAgentId]);

	// Handle agent deletion after initial notification
	React.useEffect(() => {
		if (!hasNotifiedAgentRef.current) return;
		if (!localSelectedAgentId) return;

		// Check if currently selected agent still exists
		const agentExists = agents.some((a) => a.id === localSelectedAgentId);

		if (!agentExists && agents.length > 0) {
			// Current agent was deleted, fall back to default or first
			const defaultAgent = agents.find((a) => a.isDefault);
			const agentToSelect = defaultAgent || agents[0];
			if (agentToSelect) {
				setLocalSelectedAgentId(agentToSelect.id);
				onAgentChange(agentToSelect.id);
			}
		}
	}, [localSelectedAgentId, agents, onAgentChange, setLocalSelectedAgentId]);

	const selectedWorkspace = workspaces.find(
		(ws) => ws.id === localSelectedWorkspaceId,
	);
	const selectedAgent = agents.find((a) => a.id === localSelectedAgentId);

	const getAgentIcons = (agent: Agent): Icon[] | undefined => {
		const agentType = agentTypes.find((t) => t.id === agent.agentType);
		return agentType?.icons;
	};

	const getAgentName = (agent: Agent): string => {
		const agentType = agentTypes.find((t) => t.id === agent.agentType);
		return agentType?.name || agent.agentType;
	};

	const handleSelectAgent = (agentId: string) => {
		setLocalSelectedAgentId(agentId); // This automatically persists via usePersistedState
		onAgentChange(agentId);
	};

	const handleSelectWorkspace = (workspaceId: string) => {
		setLocalSelectedWorkspaceId(workspaceId);
		onWorkspaceChange(workspaceId);
	};

	const handleAddSampleWorkspace = React.useCallback(async () => {
		setIsCreatingSampleWorkspace(true);
		try {
			await handleAddWorkspace({
				path: "https://github.com/obot-platform/disco-example",
				sourceType: "git",
			});
		} catch (error) {
			console.error("Failed to create sample workspace:", error);
		} finally {
			setIsCreatingSampleWorkspace(false);
		}
	}, [handleAddWorkspace]);

	if (!show) {
		return null;
	}

	// Don't render until agents and workspaces have loaded to prevent flickering
	if (isLoadingAgents || isLoadingWorkspaces) {
		return null;
	}

	return (
		<>
			<WelcomeHeader
				show={show}
				hasAgent={!!selectedAgent}
				hasWorkspace={!!selectedWorkspace}
				agentsCount={agents.length}
				workspacesCount={workspaces.length}
				onAddAgent={() => agentDialog.open()}
				onAddWorkspace={(mode) => workspaceDialog.open({ mode })}
				onAddSampleWorkspace={handleAddSampleWorkspace}
				isCreatingSampleWorkspace={isCreatingSampleWorkspace}
			/>
			<WelcomeSelectors
				show={show}
				agents={agents}
				workspaces={workspaces}
				selectedAgent={selectedAgent}
				selectedWorkspace={selectedWorkspace}
				getAgentIcons={getAgentIcons}
				getAgentName={getAgentName}
				onSelectAgent={handleSelectAgent}
				onSelectWorkspace={handleSelectWorkspace}
				onAddAgent={() => agentDialog.open()}
				onAddWorkspace={() => workspaceDialog.open()}
			/>
		</>
	);
}
