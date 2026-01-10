"use client";

import * as React from "react";
import type { Agent } from "@/lib/api-types";

export function useDialogState() {
	const [showAddWorkspaceDialog, setShowAddWorkspaceDialog] =
		React.useState(false);
	const [showAddAgentDialog, setShowAddAgentDialog] = React.useState(false);
	const [editingAgent, setEditingAgent] = React.useState<Agent | null>(null);

	const openWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(true);
	}, []);

	const closeWorkspaceDialog = React.useCallback(() => {
		setShowAddWorkspaceDialog(false);
	}, []);

	const openAgentDialog = React.useCallback((agent?: Agent) => {
		setEditingAgent(agent || null);
		setShowAddAgentDialog(true);
	}, []);

	const closeAgentDialog = React.useCallback(() => {
		setEditingAgent(null);
		setShowAddAgentDialog(false);
	}, []);

	const handleAgentDialogOpenChange = React.useCallback((open: boolean) => {
		if (!open) {
			setEditingAgent(null);
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
		openAgentDialog,
		closeAgentDialog,
		handleAgentDialogOpenChange,
	};
}
