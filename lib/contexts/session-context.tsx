"use client";

import * as React from "react";
import useSWR from "swr";
import { api } from "@/lib/api-client";
import type {
	Agent,
	Session,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
import { useProjectEvents } from "@/lib/hooks/use-project-events";
import { useWorkspaces } from "@/lib/hooks/use-workspaces";

interface SessionContextValue {
	// Data from SWR hooks
	workspaces: Workspace[];
	agents: Agent[];
	agentTypes: SupportedAgentType[];
	workspacesLoading: boolean;
	agentsLoading: boolean;

	// Selection state
	selectedSessionId: string | null;
	selectedAgentId: string | null;
	preselectedWorkspaceId: string | null;
	workspaceSelectTrigger: number;
	chatResetTrigger: number;

	// Derived state (fetched via SWR)
	selectedSession: Session | null | undefined;
	sessionAgent: Agent | null;
	sessionWorkspace: Workspace | null;

	// Actions
	mutateSelectedSession: () => void;
	selectSession: (sessionId: string | null) => void;
	selectAgent: (agentId: string | null) => void;
	handleSessionSelect: (session: { id: string }) => void;
	handleNewSession: () => void;
	handleAddSession: (workspaceId: string) => void;
	handleSessionCreated: (sessionId: string) => Promise<void>;

	// Mutations (pass through from hooks)
	createWorkspace: ReturnType<typeof useWorkspaces>["createWorkspace"];
	deleteWorkspace: ReturnType<typeof useWorkspaces>["deleteWorkspace"];
	mutateWorkspaces: ReturnType<typeof useWorkspaces>["mutate"];
	createAgent: ReturnType<typeof useAgents>["createAgent"];
	updateAgent: ReturnType<typeof useAgents>["updateAgent"];
	mutateAgents: ReturnType<typeof useAgents>["mutate"];
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

export function useSessionContext() {
	const context = React.useContext(SessionContext);
	if (!context) {
		throw new Error("useSessionContext must be used within a SessionProvider");
	}
	return context;
}

interface SessionProviderProps {
	children: React.ReactNode;
}

export function SessionProvider({ children }: SessionProviderProps) {
	// Subscribe to SSE events first, before any data fetching
	// This ensures we don't miss events that occur during initial data load
	useProjectEvents();

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

	// Selection state (not persisted - always starts at home screen on refresh)
	const [selectedSessionId, setSelectedSessionId] = React.useState<
		string | null
	>(null);
	const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
		null,
	);
	const [preselectedWorkspaceId, setPreselectedWorkspaceId] = React.useState<
		string | null
	>(null);
	const [workspaceSelectTrigger, setWorkspaceSelectTrigger] = React.useState(0);
	const [chatResetTrigger, setChatResetTrigger] = React.useState(0);

	// Fetch the selected session directly via SWR (lazy loading)
	const { data: selectedSession, mutate: mutateSelectedSession } = useSWR(
		selectedSessionId ? `session-${selectedSessionId}` : null,
		() => (selectedSessionId ? api.getSession(selectedSessionId) : null),
	);

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

	// Actions
	const selectSession = React.useCallback(
		(sessionId: string | null) => {
			setSelectedSessionId(sessionId);
		},
		[setSelectedSessionId],
	);

	const selectAgent = React.useCallback((agentId: string | null) => {
		setSelectedAgentId(agentId);
	}, []);

	const handleSessionSelect = React.useCallback(
		(session: { id: string }) => {
			setSelectedSessionId(session.id);
			setPreselectedWorkspaceId(null);
		},
		[setSelectedSessionId],
	);

	const handleNewSession = React.useCallback(() => {
		setSelectedSessionId(null);
		setPreselectedWorkspaceId(null);
		setChatResetTrigger((prev) => prev + 1);
	}, [setSelectedSessionId]);

	const handleAddSession = React.useCallback(
		(workspaceId: string) => {
			setSelectedSessionId(null);
			setPreselectedWorkspaceId(workspaceId);
			setWorkspaceSelectTrigger((prev) => prev + 1);
		},
		[setSelectedSessionId],
	);

	const handleSessionCreated = React.useCallback(
		async (sessionId: string) => {
			// Refresh the workspaces list (for sidebar display)
			await mutateWorkspaces();

			// Set the session ID - SWR will automatically fetch the session
			setSelectedSessionId(sessionId);
			setPreselectedWorkspaceId(null);
		},
		[mutateWorkspaces, setSelectedSessionId],
	);

	// Set agent ID when selected session changes
	React.useEffect(() => {
		if (selectedSession?.agentId) {
			setSelectedAgentId(selectedSession.agentId);
		}
	}, [selectedSession?.agentId]);

	const value = React.useMemo<SessionContextValue>(
		() => ({
			// Data
			workspaces,
			agents,
			agentTypes,
			workspacesLoading,
			agentsLoading,

			// Selection state
			selectedSessionId,
			selectedAgentId,
			preselectedWorkspaceId,
			workspaceSelectTrigger,
			chatResetTrigger,

			// Derived state
			selectedSession: selectedSession ?? null,
			sessionAgent,
			sessionWorkspace,

			// Actions
			mutateSelectedSession: () => mutateSelectedSession(),
			selectSession,
			selectAgent,
			handleSessionSelect,
			handleNewSession,
			handleAddSession,
			handleSessionCreated,

			// Mutations
			createWorkspace,
			deleteWorkspace,
			mutateWorkspaces,
			createAgent,
			updateAgent,
			mutateAgents,
		}),
		[
			workspaces,
			agents,
			agentTypes,
			workspacesLoading,
			agentsLoading,
			selectedSessionId,
			selectedAgentId,
			preselectedWorkspaceId,
			workspaceSelectTrigger,
			chatResetTrigger,
			selectedSession,
			sessionAgent,
			sessionWorkspace,
			mutateSelectedSession,
			selectSession,
			selectAgent,
			handleSessionSelect,
			handleNewSession,
			handleAddSession,
			handleSessionCreated,
			createWorkspace,
			deleteWorkspace,
			mutateWorkspaces,
			createAgent,
			updateAgent,
			mutateAgents,
		],
	);

	return (
		<SessionContext.Provider value={value}>{children}</SessionContext.Provider>
	);
}
