"use client";

import * as React from "react";
import { api } from "@/lib/api-client";
import type {
	Agent,
	Session,
	SupportedAgentType,
	Workspace,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import { useAgents } from "@/lib/hooks/use-agents";
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

	// Derived state (computed from selection + data)
	selectedSession: Session | null;
	sessionAgent: Agent | null;
	sessionWorkspace: Workspace | null;

	// Actions
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

	// Selection state
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

	// Derive full objects from SWR data - automatically updates when data changes
	const selectedSession = React.useMemo(() => {
		if (!selectedSessionId) return null;
		for (const workspace of workspaces) {
			const session = workspace.sessions.find(
				(s) => s.id === selectedSessionId,
			);
			if (session) return session;
		}
		return null;
	}, [selectedSessionId, workspaces]);

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
	const selectSession = React.useCallback((sessionId: string | null) => {
		setSelectedSessionId(sessionId);
	}, []);

	const selectAgent = React.useCallback((agentId: string | null) => {
		setSelectedAgentId(agentId);
	}, []);

	const handleSessionSelect = React.useCallback((session: { id: string }) => {
		setSelectedSessionId(session.id);
		setPreselectedWorkspaceId(null);
	}, []);

	const handleNewSession = React.useCallback(() => {
		setSelectedSessionId(null);
		setPreselectedWorkspaceId(null);
		setChatResetTrigger((prev) => prev + 1);
	}, []);

	const handleAddSession = React.useCallback((workspaceId: string) => {
		setSelectedSessionId(null);
		setPreselectedWorkspaceId(workspaceId);
		setWorkspaceSelectTrigger((prev) => prev + 1);
	}, []);

	const handleSessionCreated = React.useCallback(
		async (sessionId: string) => {
			try {
				// Refresh the workspaces list first (sessions are nested within workspaces)
				await mutateWorkspaces();

				// Set the session ID - the full session object will be derived from workspaces
				setSelectedSessionId(sessionId);
				setPreselectedWorkspaceId(null);

				// Fetch the session to get agentId for agent selection
				const session = await api.getSession(sessionId);
				if (session.agentId) {
					setSelectedAgentId(session.agentId);
				}
			} catch (error) {
				console.error("Failed to fetch created session:", error);
			}
		},
		[mutateWorkspaces],
	);

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
			selectedSession,
			sessionAgent,
			sessionWorkspace,

			// Actions
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
