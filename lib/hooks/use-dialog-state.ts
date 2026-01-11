"use client";

import * as React from "react";
import type { Agent } from "@/lib/api-types";

export function useDialogState() {
	const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] =
		React.useState(false);
	const [showAddAgentDialog, setShowAddAgentDialog] = React.useState(false);
	const [editingAgent, setEditingAgent] = React.useState<Agent | null>(null);
	const [preselectedAgentTypeId, setPreselectedAgentTypeId] = React.useState<
		string | null
	>(null);

	const openWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(true);
	}, []);

	const closeWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(false);
	}, []);

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

	return {
		// Workspace dialog
		showAddWorkspaceDialog,
		setShowAddWorkspaceDialog,
		openWorkspaceDialog,
		closeWorkspaceDialog,

		// Agent dialog
		showAddAgentDialog,
		editingAgent,
		preselectedAgentTypeId,
		openAgentDialog,
		closeAgentDialog,
		handleAgentDialogOpenChange,
	};
}
