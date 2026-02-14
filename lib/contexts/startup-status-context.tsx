import * as React from "react";
import type { StartupTask } from "@/lib/api-types";

interface StartupStatusState {
	tasks: StartupTask[];
	hasActiveTasks: boolean;
}

const StartupStatusContext = React.createContext<StartupStatusState>({
	tasks: [],
	hasActiveTasks: false,
});

export function useStartupStatus() {
	return React.useContext(StartupStatusContext);
}

export { StartupStatusContext };
