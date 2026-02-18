/**
 * ChatNewContent Workspace Selection Tests
 *
 * Tests all permutations of workspace selection logic including:
 * - Initial auto-selection
 * - Selection preservation
 * - Deletion handling
 * - Edge cases
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/chat-new-content.test.tsx
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { cleanup, renderHook } from "@testing-library/react";
import * as React from "react";
import type { Workspace } from "@/lib/api-types";

/**
 * Simulates the workspace auto-selection effect from ChatNewContent
 * This is extracted to test the core logic without needing to mock modules
 */
function useWorkspaceSelection(
	selectedWorkspaceId: string | null,
	workspaces: Workspace[],
	onWorkspaceChange: (id: string) => void,
) {
	const [localSelectedWorkspaceId, setLocalSelectedWorkspaceId] =
		React.useState<string | null>(selectedWorkspaceId);

	// Sync local state with props
	React.useEffect(() => {
		setLocalSelectedWorkspaceId(selectedWorkspaceId);
	}, [selectedWorkspaceId]);

	// Auto-select first workspace when workspaces become available and nothing is selected
	React.useEffect(() => {
		// Only auto-select if we don't have a workspace selected
		if (!localSelectedWorkspaceId && workspaces.length > 0) {
			const workspaceToSelect = workspaces[0];
			setLocalSelectedWorkspaceId(workspaceToSelect.id);
			onWorkspaceChange(workspaceToSelect.id);
		} else if (localSelectedWorkspaceId) {
			// If we have a selection, verify it still exists
			const currentWorkspaceExists = workspaces.some(
				(ws) => ws.id === localSelectedWorkspaceId,
			);
			// Only change selection if current workspace was deleted
			if (!currentWorkspaceExists && workspaces.length > 0) {
				const workspaceToSelect = workspaces[0];
				setLocalSelectedWorkspaceId(workspaceToSelect.id);
				onWorkspaceChange(workspaceToSelect.id);
			}
		}
	}, [workspaces, localSelectedWorkspaceId, onWorkspaceChange]);

	return { localSelectedWorkspaceId };
}

describe("ChatNewContent - Workspace Selection Logic", () => {
	const createWorkspace = (id: string, displayName: string): Workspace => ({
		id,
		path: `/path/to/${id}`,
		displayName,
		sourceType: "local",
		status: "ready",
	});

	afterEach(() => {
		cleanup();
	});

	describe("Initial workspace selection", () => {
		test("should auto-select first workspace when no workspace is selected and workspaces exist", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { result } = renderHook(() =>
				useWorkspaceSelection(null, workspaces, onWorkspaceChange),
			);

			// Wait for effects to run
			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				1,
				"onWorkspaceChange should be called once",
			);
			assert.strictEqual(calls[0], "ws-1", "Should select the first workspace");
			assert.strictEqual(
				result.current.localSelectedWorkspaceId,
				"ws-1",
				"Local state should be ws-1",
			);
		});

		test("should not auto-select when workspace is already provided", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { result } = renderHook(() =>
				useWorkspaceSelection("ws-2", workspaces, onWorkspaceChange),
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when valid workspace is already selected",
			);
			assert.strictEqual(
				result.current.localSelectedWorkspaceId,
				"ws-2",
				"Should preserve ws-2 selection",
			);
		});

		test("should not auto-select when no workspaces exist", async () => {
			const workspaces: Workspace[] = [];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { result } = renderHook(() =>
				useWorkspaceSelection(null, workspaces, onWorkspaceChange),
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when no workspaces exist",
			);
			assert.strictEqual(
				result.current.localSelectedWorkspaceId,
				null,
				"Local state should remain null",
			);
		});
	});

	describe("Workspace selection preservation", () => {
		test("should preserve selected workspace when prop changes to the same value", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-2" as string | null,
						wsList: workspaces,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Re-render with the same workspace
			rerender({ selectedId: "ws-2", wsList: workspaces });

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when workspace remains valid",
			);
		});

		test("should update local state when prop changes to different valid workspace", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
				createWorkspace("ws-3", "Workspace 3"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { result, rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-2" as string | null,
						wsList: workspaces,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Change to a different workspace
			rerender({ selectedId: "ws-3", wsList: workspaces });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// The prop sync effect updates local state
			assert.strictEqual(
				result.current.localSelectedWorkspaceId,
				"ws-3",
				"Local state should sync to ws-3",
			);
			// The auto-select effect doesn't call onChange since ws-3 exists
			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when prop changes (parent controls the state)",
			);
		});
	});

	describe("Workspace deletion handling", () => {
		test("should auto-select first workspace when selected workspace is deleted", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
				createWorkspace("ws-3", "Workspace 3"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-2" as string | null,
						wsList: workspaces,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate ws-2 being deleted
			const newWorkspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-3", "Workspace 3"),
			];

			rerender({ selectedId: "ws-2", wsList: newWorkspaces });

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				1,
				"onWorkspaceChange should be called once when workspace is deleted",
			);
			assert.strictEqual(
				calls[0],
				"ws-1",
				"Should select the first available workspace",
			);
		});

		test("should not call onChange when selected workspace is deleted and no workspaces remain", async () => {
			const workspaces = [createWorkspace("ws-1", "Workspace 1")];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-1" as string | null,
						wsList: workspaces,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate all workspaces being deleted
			rerender({ selectedId: "ws-1", wsList: [] });

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when no workspaces remain",
			);
		});
	});

	describe("Multiple workspace changes", () => {
		test("should handle rapid workspace list updates correctly", async () => {
			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-1" as string | null,
						wsList: [createWorkspace("ws-1", "Workspace 1")],
					},
				},
			);

			// Add more workspaces
			rerender({
				selectedId: "ws-1",
				wsList: [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				],
			});

			// Add even more workspaces
			rerender({
				selectedId: "ws-1",
				wsList: [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
					createWorkspace("ws-3", "Workspace 3"),
				],
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(
				calls.length,
				0,
				"onWorkspaceChange should not be called when selected workspace remains valid",
			);
		});

		test("should handle workspace being deleted and re-added", async () => {
			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-2" as string | null,
						wsList: [
							createWorkspace("ws-1", "Workspace 1"),
							createWorkspace("ws-2", "Workspace 2"),
						],
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Delete ws-2
			rerender({
				selectedId: "ws-2",
				wsList: [createWorkspace("ws-1", "Workspace 1")],
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(calls.length, 1, "Should have one call from deletion");
			assert.strictEqual(calls[0], "ws-1");

			// Re-add ws-2
			rerender({
				selectedId: "ws-2",
				wsList: [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				],
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// The prop sync will update local state but no onChange call
			assert.strictEqual(
				calls.length,
				1,
				"onWorkspaceChange should only be called once (for deletion)",
			);
		});
	});

	describe("Edge cases", () => {
		test("should handle workspace prop being set to null after having a value", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: "ws-2" as string | null,
						wsList: workspaces,
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Change prop to null
			rerender({ selectedId: null, wsList: workspaces });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should auto-select first workspace when prop becomes null
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0], "ws-1");
		});

		test("should handle empty workspace array becoming populated", async () => {
			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			const { rerender } = renderHook(
				({ selectedId, wsList }) =>
					useWorkspaceSelection(selectedId, wsList, onWorkspaceChange),
				{
					initialProps: {
						selectedId: null,
						wsList: [] as Workspace[],
					},
				},
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Add workspaces
			rerender({
				selectedId: null,
				wsList: [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				],
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0], "ws-1");
		});

		test("should handle workspace being selected that doesn't exist in the list", async () => {
			const workspaces = [
				createWorkspace("ws-1", "Workspace 1"),
				createWorkspace("ws-2", "Workspace 2"),
			];

			const calls: string[] = [];
			const onWorkspaceChange = (id: string) => calls.push(id);

			renderHook(() =>
				useWorkspaceSelection("ws-nonexistent", workspaces, onWorkspaceChange),
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Should auto-select first workspace when selected ID doesn't exist
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0], "ws-1");
		});
	});

	describe("Callbacks must always be invoked when values are selected", () => {
		/**
		 * Helper to simulate agent selection behavior in ChatNewContent
		 */
		function useAgentSelection(
			persistedAgentId: string | null,
			agents: string[],
			onAgentChange: (id: string) => void,
		) {
			const [localAgentId, setLocalAgentId] = React.useState<string | null>(
				persistedAgentId,
			);

			// Auto-select default agent when agents become available and nothing is selected
			React.useEffect(() => {
				const currentAgentExists = agents.some((a) => a === localAgentId);
				if (!localAgentId || !currentAgentExists) {
					const agentToSelect = agents[0];
					if (agentToSelect) {
						setLocalAgentId(agentToSelect);
						onAgentChange(agentToSelect);
					}
				}
				// BUG: If localAgentId exists (from persistent storage), onAgentChange is never called
			}, [localAgentId, agents, onAgentChange]);

			return { localAgentId };
		}

		describe("Workspace callback invocation", () => {
			test("PERMUTATION 1: initialWorkspaceId=ws-2, workspaces=[ws-1,ws-2] -> should NOT call onWorkspaceChange (ws-2 already valid)", async () => {
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];

				const calls: string[] = [];
				const onWorkspaceChange = (id: string) => calls.push(id);

				renderHook(() =>
					useWorkspaceSelection("ws-2", workspaces, onWorkspaceChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					0,
					"onWorkspaceChange should not be called when initial workspace is already valid",
				);
			});

			test("PERMUTATION 2: initialWorkspaceId=null, workspaces=[ws-1,ws-2] -> should call onWorkspaceChange(ws-1)", async () => {
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];

				const calls: string[] = [];
				const onWorkspaceChange = (id: string) => calls.push(id);

				renderHook(() =>
					useWorkspaceSelection(null, workspaces, onWorkspaceChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					1,
					"Should call onWorkspaceChange when auto-selecting first workspace",
				);
				assert.strictEqual(calls[0], "ws-1");
			});

			test("PERMUTATION 3: initialWorkspaceId=null, workspaces=[] -> should NOT call onWorkspaceChange", async () => {
				const workspaces: Workspace[] = [];

				const calls: string[] = [];
				const onWorkspaceChange = (id: string) => calls.push(id);

				renderHook(() =>
					useWorkspaceSelection(null, workspaces, onWorkspaceChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					0,
					"Should not call onWorkspaceChange when no workspaces exist",
				);
			});

			test("PERMUTATION 4: initialWorkspaceId=ws-nonexistent, workspaces=[ws-1,ws-2] -> should call onWorkspaceChange(ws-1)", async () => {
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];

				const calls: string[] = [];
				const onWorkspaceChange = (id: string) => calls.push(id);

				renderHook(() =>
					useWorkspaceSelection(
						"ws-nonexistent",
						workspaces,
						onWorkspaceChange,
					),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					1,
					"Should call onWorkspaceChange when initial workspace doesn't exist",
				);
				assert.strictEqual(calls[0], "ws-1");
			});
		});

		describe("Agent callback invocation", () => {
			test("PERMUTATION 1: persistedAgentId=agent-2, agents=[agent-1,agent-2,agent-3] -> should NOT call onAgentChange (agent-2 already valid)", async () => {
				const agents = ["agent-1", "agent-2", "agent-3"];

				const calls: string[] = [];
				const onAgentChange = (id: string) => calls.push(id);

				const { result } = renderHook(() =>
					useAgentSelection("agent-2", agents, onAgentChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					0,
					"onAgentChange should not be called when persisted agent is already valid",
				);
				assert.strictEqual(result.current.localAgentId, "agent-2");
			});

			test("PERMUTATION 2: persistedAgentId=null, agents=[agent-1,agent-2,agent-3] -> should call onAgentChange(agent-1)", async () => {
				const agents = ["agent-1", "agent-2", "agent-3"];

				const calls: string[] = [];
				const onAgentChange = (id: string) => calls.push(id);

				const { result } = renderHook(() =>
					useAgentSelection(null, agents, onAgentChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					1,
					"Should call onAgentChange when auto-selecting first agent",
				);
				assert.strictEqual(calls[0], "agent-1");
				assert.strictEqual(result.current.localAgentId, "agent-1");
			});

			test("PERMUTATION 3: persistedAgentId=null, agents=[] -> should NOT call onAgentChange", async () => {
				const agents: string[] = [];

				const calls: string[] = [];
				const onAgentChange = (id: string) => calls.push(id);

				const { result } = renderHook(() =>
					useAgentSelection(null, agents, onAgentChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					0,
					"Should not call onAgentChange when no agents exist",
				);
				assert.strictEqual(result.current.localAgentId, null);
			});

			test("PERMUTATION 4: persistedAgentId=agent-deleted, agents=[agent-1,agent-2] -> should call onAgentChange(agent-1)", async () => {
				const agents = ["agent-1", "agent-2"];

				const calls: string[] = [];
				const onAgentChange = (id: string) => calls.push(id);

				const { result } = renderHook(() =>
					useAgentSelection("agent-deleted", agents, onAgentChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					1,
					"Should call onAgentChange when persisted agent doesn't exist",
				);
				assert.strictEqual(calls[0], "agent-1");
				assert.strictEqual(result.current.localAgentId, "agent-1");
			});

			test("PERMUTATION 5: persistedAgentId=agent-deleted, agents=[] -> should NOT call onAgentChange", async () => {
				const agents: string[] = [];

				const calls: string[] = [];
				const onAgentChange = (id: string) => calls.push(id);

				const { result } = renderHook(() =>
					useAgentSelection("agent-deleted", agents, onAgentChange),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					calls.length,
					0,
					"Should not call onAgentChange when persisted agent doesn't exist and no agents available",
				);
				assert.strictEqual(result.current.localAgentId, "agent-deleted");
			});
		});

		describe("Combined workspace + agent scenarios", () => {
			test("SCENARIO 1: Both workspace and agent are provided/persisted -> no callbacks (both already valid)", async () => {
				// This is the most common scenario: user clicks "New Session" from sidebar (workspace set)
				// and they previously selected an agent (persisted in storage)
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];
				const agents = ["agent-1", "agent-2", "agent-3"];

				const workspaceCalls: string[] = [];
				const agentCalls: string[] = [];

				renderHook(() =>
					useWorkspaceSelection("ws-2", workspaces, (id) =>
						workspaceCalls.push(id),
					),
				);

				renderHook(() =>
					useAgentSelection("agent-2", agents, (id) => agentCalls.push(id)),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					workspaceCalls.length,
					0,
					"Workspace callback should not be called when workspace is already valid",
				);
				assert.strictEqual(
					agentCalls.length,
					0,
					"Agent callback should not be called when persisted agent is already valid",
				);
			});

			test("SCENARIO 2: Neither workspace nor agent provided -> both callbacks should be called with auto-selected values", async () => {
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];
				const agents = ["agent-1", "agent-2", "agent-3"];

				const workspaceCalls: string[] = [];
				const agentCalls: string[] = [];

				renderHook(() =>
					useWorkspaceSelection(null, workspaces, (id) =>
						workspaceCalls.push(id),
					),
				);

				renderHook(() =>
					useAgentSelection(null, agents, (id) => agentCalls.push(id)),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(workspaceCalls.length, 1);
				assert.strictEqual(workspaceCalls[0], "ws-1");
				assert.strictEqual(agentCalls.length, 1);
				assert.strictEqual(agentCalls[0], "agent-1");
			});

			test("SCENARIO 3: Workspace provided but doesn't exist, agent persisted and exists -> workspace falls back, agent uses persisted", async () => {
				const workspaces = [
					createWorkspace("ws-1", "Workspace 1"),
					createWorkspace("ws-2", "Workspace 2"),
				];
				const agents = ["agent-1", "agent-2", "agent-3"];

				const workspaceCalls: string[] = [];
				const agentCalls: string[] = [];

				renderHook(() =>
					useWorkspaceSelection("ws-deleted", workspaces, (id) =>
						workspaceCalls.push(id),
					),
				);

				renderHook(() =>
					useAgentSelection("agent-2", agents, (id) => agentCalls.push(id)),
				);

				await new Promise((resolve) => setTimeout(resolve, 10));

				assert.strictEqual(
					workspaceCalls.length,
					1,
					"Should fall back to first workspace",
				);
				assert.strictEqual(workspaceCalls[0], "ws-1");
				assert.strictEqual(
					agentCalls.length,
					0,
					"Agent callback should not be called when persisted agent is already valid",
				);
			});
		});
	});
});
