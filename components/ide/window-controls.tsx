import { useEffect, useState } from "react";
import { isTauri } from "@/lib/api-config";

type Platform = "macos" | "windows" | "linux";

export function WindowControls() {
	const [os, setOs] = useState<Platform>("linux");
	const [isMaximized, setIsMaximized] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		if (!isTauri()) return;

		setMounted(true);

		const init = async () => {
			const { platform } = await import("@tauri-apps/plugin-os");
			const { getCurrentWindow } = await import("@tauri-apps/api/window");

			const p = platform();
			if (p === "macos") setOs("macos");
			else if (p === "windows") setOs("windows");
			else setOs("linux");

			const maximized = await getCurrentWindow().isMaximized();
			setIsMaximized(maximized);

			const unlisten = await getCurrentWindow().onResized(async () => {
				const max = await getCurrentWindow().isMaximized();
				setIsMaximized(max);
			});

			return unlisten;
		};

		let cleanup: (() => void) | undefined;
		init().then((unlisten) => {
			cleanup = unlisten;
		});

		return () => {
			cleanup?.();
		};
	}, []);

	if (!isTauri() || !mounted) return null;

	// macOS uses native traffic light controls via titleBarStyle: "Overlay"
	if (os === "macos") return null;

	const handleMinimize = async () => {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		getCurrentWindow().minimize();
	};

	const handleMaximize = async () => {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		getCurrentWindow().toggleMaximize();
	};

	const handleClose = async () => {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		getCurrentWindow().close();
	};

	// Windows/Linux controls on the right - negative margin to extend past header padding
	return (
		<div className="flex items-center h-full pointer-events-auto -mr-4">
			<button
				type="button"
				className="tauri-no-drag w-[46px] h-full border-none bg-transparent cursor-pointer flex items-center justify-center text-foreground transition-colors duration-150 hover:bg-foreground/10"
				onClick={handleMinimize}
				aria-label="Minimize"
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path d="M0 5H10" stroke="currentColor" strokeWidth="1" />
				</svg>
			</button>
			<button
				type="button"
				className="tauri-no-drag w-[46px] h-full border-none bg-transparent cursor-pointer flex items-center justify-center text-foreground transition-colors duration-150 hover:bg-foreground/10"
				onClick={handleMaximize}
				aria-label="Maximize"
			>
				{isMaximized ? (
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<path
							d="M2 0H10V8H8V10H0V2H2V0ZM3 3V9H7V3H3ZM3 2H9V7H8V2H3Z"
							fill="currentColor"
						/>
					</svg>
				) : (
					<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
						<rect
							x="0.5"
							y="0.5"
							width="9"
							height="9"
							stroke="currentColor"
							fill="none"
						/>
					</svg>
				)}
			</button>
			<button
				type="button"
				className="tauri-no-drag w-[46px] h-full border-none bg-transparent cursor-pointer flex items-center justify-center text-foreground transition-colors duration-150 hover:bg-[#e81123] hover:text-white"
				onClick={handleClose}
				aria-label="Close"
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path
						d="M0 0L10 10M10 0L0 10"
						stroke="currentColor"
						strokeWidth="1"
					/>
				</svg>
			</button>
		</div>
	);
}
