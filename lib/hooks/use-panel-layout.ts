"use client";

import * as React from "react";
import { STORAGE_KEYS } from "./use-persisted-state";

export type PanelState = "normal" | "minimized" | "maximized";

/**
 * Load persisted panel state from localStorage
 */
function loadPersistedState(): Partial<PanelLayoutState> {
	if (typeof window === "undefined") return {};

	try {
		const diffPanelState = localStorage.getItem(STORAGE_KEYS.DIFF_PANEL_STATE);
		const bottomPanelState = localStorage.getItem(
			STORAGE_KEYS.BOTTOM_PANEL_STATE,
		);
		const diffPanelHeight = localStorage.getItem(
			STORAGE_KEYS.DIFF_PANEL_HEIGHT,
		);

		return {
			...(diffPanelState && { diffPanelState: JSON.parse(diffPanelState) }),
			...(bottomPanelState && {
				bottomPanelState: JSON.parse(bottomPanelState),
			}),
			...(diffPanelHeight && { diffPanelHeight: JSON.parse(diffPanelHeight) }),
		};
	} catch {
		return {};
	}
}

/**
 * Save panel state to localStorage
 */
function savePersistedState(state: PanelLayoutState): void {
	if (typeof window === "undefined") return;

	try {
		localStorage.setItem(
			STORAGE_KEYS.DIFF_PANEL_STATE,
			JSON.stringify(state.diffPanelState),
		);
		localStorage.setItem(
			STORAGE_KEYS.BOTTOM_PANEL_STATE,
			JSON.stringify(state.bottomPanelState),
		);
		localStorage.setItem(
			STORAGE_KEYS.DIFF_PANEL_HEIGHT,
			JSON.stringify(state.diffPanelHeight),
		);
	} catch {
		// Ignore storage errors
	}
}

type PanelAction =
	| { type: "INIT"; persisted: Partial<PanelLayoutState> }
	| { type: "MINIMIZE_DIFF" }
	| { type: "MAXIMIZE_DIFF" }
	| { type: "MINIMIZE_BOTTOM" }
	| { type: "MAXIMIZE_BOTTOM" }
	| { type: "RESET" }
	| { type: "SHOW_DIFF" }
	| { type: "CLOSE_DIFF" }
	| { type: "RESIZE_DIFF"; height: number };

interface PanelLayoutState {
	diffPanelState: PanelState;
	bottomPanelState: PanelState;
	diffPanelHeight: number;
	showDiffPanel: boolean;
}

function panelReducer(
	state: PanelLayoutState,
	action: PanelAction,
): PanelLayoutState {
	switch (action.type) {
		case "INIT":
			return { ...state, ...action.persisted };

		case "MINIMIZE_DIFF":
			if (state.diffPanelState === "minimized") {
				return {
					...state,
					diffPanelState: "normal",
					bottomPanelState: "normal",
				};
			}
			return {
				...state,
				diffPanelState: "minimized",
				bottomPanelState: "maximized",
			};

		case "MAXIMIZE_DIFF":
			if (state.diffPanelState === "maximized") {
				return {
					...state,
					diffPanelState: "normal",
					bottomPanelState: "normal",
				};
			}
			return {
				...state,
				diffPanelState: "maximized",
				bottomPanelState: "minimized",
			};

		case "MINIMIZE_BOTTOM":
			if (state.bottomPanelState === "minimized") {
				return {
					...state,
					bottomPanelState: "normal",
					diffPanelState: "normal",
				};
			}
			return {
				...state,
				bottomPanelState: "minimized",
				diffPanelState: state.showDiffPanel
					? "maximized"
					: state.diffPanelState,
			};

		case "MAXIMIZE_BOTTOM":
			if (state.bottomPanelState === "maximized") {
				return {
					...state,
					bottomPanelState: "normal",
					diffPanelState: "normal",
				};
			}
			return {
				...state,
				bottomPanelState: "maximized",
				diffPanelState: "minimized",
			};

		case "RESET":
			return { ...state, diffPanelState: "normal", bottomPanelState: "normal" };

		case "SHOW_DIFF":
			return {
				...state,
				showDiffPanel: true,
				diffPanelState:
					state.diffPanelState === "minimized"
						? "normal"
						: state.diffPanelState,
			};

		case "CLOSE_DIFF":
			return {
				...state,
				showDiffPanel: false,
				diffPanelState: "normal",
				bottomPanelState:
					state.bottomPanelState === "minimized"
						? "normal"
						: state.bottomPanelState,
			};

		case "RESIZE_DIFF":
			return {
				...state,
				diffPanelHeight: Math.min(80, Math.max(20, action.height)),
			};

		default:
			return state;
	}
}

export function usePanelLayout() {
	const [state, dispatch] = React.useReducer(panelReducer, {
		diffPanelState: "normal",
		bottomPanelState: "normal",
		diffPanelHeight: 50,
		showDiffPanel: false,
	});

	const mainRef = React.useRef<HTMLDivElement>(null);

	// Load persisted state on mount
	React.useEffect(() => {
		const persisted = loadPersistedState();
		if (Object.keys(persisted).length > 0) {
			dispatch({ type: "INIT", persisted });
		}
	}, []);

	// Save state changes to localStorage
	React.useEffect(() => {
		savePersistedState(state);
	}, [state]);

	const handleResize = React.useCallback(
		(delta: number) => {
			if (!mainRef.current) return;
			const containerHeight = mainRef.current.clientHeight;
			const deltaPercent = (delta / containerHeight) * 100;
			dispatch({
				type: "RESIZE_DIFF",
				height: state.diffPanelHeight + deltaPercent,
			});
		},
		[state.diffPanelHeight],
	);

	const getDiffPanelStyle = React.useCallback((): React.CSSProperties => {
		if (!state.showDiffPanel) return { height: 0 };
		if (state.diffPanelState === "minimized") return { height: 40 };
		if (state.diffPanelState === "maximized") return { flex: 1 };
		return { height: `${state.diffPanelHeight}%` };
	}, [state.showDiffPanel, state.diffPanelState, state.diffPanelHeight]);

	const getBottomPanelStyle = React.useCallback((): React.CSSProperties => {
		if (state.bottomPanelState === "minimized") return { height: 40 };
		if (state.bottomPanelState === "maximized") return { flex: 1 };
		return { flex: 1 };
	}, [state.bottomPanelState]);

	const showResizeHandle =
		state.showDiffPanel &&
		state.diffPanelState === "normal" &&
		state.bottomPanelState === "normal";

	// Memoize action handlers
	const handleDiffMinimize = React.useCallback(
		() => dispatch({ type: "MINIMIZE_DIFF" }),
		[],
	);
	const handleDiffMaximize = React.useCallback(
		() => dispatch({ type: "MAXIMIZE_DIFF" }),
		[],
	);
	const handleBottomMinimize = React.useCallback(
		() => dispatch({ type: "MINIMIZE_BOTTOM" }),
		[],
	);
	const handleBottomMaximize = React.useCallback(
		() => dispatch({ type: "MAXIMIZE_BOTTOM" }),
		[],
	);
	const handleCloseDiffPanel = React.useCallback(
		() => dispatch({ type: "CLOSE_DIFF" }),
		[],
	);
	const showDiff = React.useCallback(() => dispatch({ type: "SHOW_DIFF" }), []);
	const resetPanels = React.useCallback(() => dispatch({ type: "RESET" }), []);

	return {
		// State
		diffPanelState: state.diffPanelState,
		bottomPanelState: state.bottomPanelState,
		showDiffPanel: state.showDiffPanel,
		showResizeHandle,
		mainRef,

		// Styles
		getDiffPanelStyle,
		getBottomPanelStyle,

		// Actions
		handleDiffMinimize,
		handleDiffMaximize,
		handleBottomMinimize,
		handleBottomMaximize,
		handleCloseDiffPanel,
		showDiff,
		resetPanels,
		handleResize,
	};
}
