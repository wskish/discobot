import * as React from "react";
import {
	STORAGE_KEYS,
	usePersistedState,
} from "@/lib/hooks/use-persisted-state";

type UpdateStatus =
	| "idle"
	| "checking"
	| "downloading"
	| "ready"
	| "installing"
	| "error";

interface UpdateContextValue {
	status: UpdateStatus;
	availableVersion: string | null;
	error: string | null;
	isIgnored: boolean;
	showBadge: boolean;
	checkForUpdate: () => Promise<void>;
	installAndRelaunch: () => Promise<void>;
	ignoreVersion: () => void;
}

const UpdateContext = React.createContext<UpdateContextValue | null>(null);

export function useUpdateContext(): UpdateContextValue | null {
	return React.useContext(UpdateContext);
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
	const [status, setStatus] = React.useState<UpdateStatus>("idle");
	const [availableVersion, setAvailableVersion] = React.useState<string | null>(
		null,
	);
	const [error, setError] = React.useState<string | null>(null);
	const [ignoredVersion, setIgnoredVersion] = usePersistedState<string | null>(
		STORAGE_KEYS.IGNORED_UPDATE_VERSION,
		null,
	);

	// Hold the Tauri Update object across renders
	const updateRef = React.useRef<Awaited<
		ReturnType<typeof import("@tauri-apps/plugin-updater").check>
	> | null>(null);

	// Use refs for values read inside checkForUpdate so the callback is stable
	const statusRef = React.useRef(status);
	statusRef.current = status;
	const ignoredVersionRef = React.useRef(ignoredVersion);
	ignoredVersionRef.current = ignoredVersion;

	// Guard against concurrent check calls
	const checkingRef = React.useRef(false);

	const checkForUpdate = React.useCallback(async () => {
		if (checkingRef.current) return;
		const currentStatus = statusRef.current;
		if (currentStatus === "downloading" || currentStatus === "installing")
			return;

		checkingRef.current = true;
		setStatus("checking");
		setError(null);

		try {
			const { check } = await import("@tauri-apps/plugin-updater");
			const updateInfo = await check();

			if (updateInfo?.available) {
				updateRef.current = updateInfo;
				setAvailableVersion(updateInfo.version);

				// If already downloaded, stay ready
				if (currentStatus === "ready") {
					setStatus("ready");
					checkingRef.current = false;
					return;
				}

				// Skip download if user has ignored this version
				if (ignoredVersionRef.current === updateInfo.version) {
					setStatus("ready");
					checkingRef.current = false;
					return;
				}

				// Download silently in the background
				setStatus("downloading");
				try {
					await updateInfo.download();
					setStatus("ready");
				} catch (downloadError) {
					console.error("Update download failed:", downloadError);
					setStatus("error");
					setError(
						downloadError instanceof Error
							? downloadError.message
							: "Download failed",
					);
				}
			} else {
				setStatus("idle");
			}
		} catch (checkError) {
			console.error("Failed to check for updates:", checkError);
			setStatus("error");
			setError(
				checkError instanceof Error
					? checkError.message
					: String(checkError),
			);
		} finally {
			checkingRef.current = false;
		}
	}, []);

	const installAndRelaunch = React.useCallback(async () => {
		const update = updateRef.current;
		if (!update) return;

		setStatus("installing");
		try {
			await update.install();
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
		} catch (installError) {
			console.error("Update install failed:", installError);
			setStatus("error");
			setError(
				installError instanceof Error ? installError.message : "Install failed",
			);
		}
	}, []);

	const ignoreVersion = React.useCallback(() => {
		if (availableVersion) {
			setIgnoredVersion(availableVersion);
		}
	}, [availableVersion, setIgnoredVersion]);

	// Check on mount and every 30 minutes
	React.useEffect(() => {
		checkForUpdate();
		const interval = setInterval(checkForUpdate, 30 * 60 * 1000);
		return () => clearInterval(interval);
	}, [checkForUpdate]);

	const isIgnored =
		availableVersion !== null && ignoredVersion === availableVersion;
	const showBadge = status === "ready" && !isIgnored;

	const value = React.useMemo<UpdateContextValue>(
		() => ({
			status,
			availableVersion,
			error,
			isIgnored,
			showBadge,
			checkForUpdate,
			installAndRelaunch,
			ignoreVersion,
		}),
		[
			status,
			availableVersion,
			error,
			isIgnored,
			showBadge,
			checkForUpdate,
			installAndRelaunch,
			ignoreVersion,
		],
	);

	return (
		<UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
	);
}
