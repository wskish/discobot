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

	const isMac = os === "macos";

	if (isMac) {
		return (
			<div className="flex items-center gap-2 pr-2 pointer-events-auto">
				<button
					type="button"
					className="tauri-no-drag w-3 h-3 rounded-full bg-[#ff5f57] flex items-center justify-center p-0 border-none cursor-pointer transition-[filter] duration-150 group/close hover:brightness-90"
					onClick={handleClose}
					aria-label="Close"
				>
					<svg
						width="8"
						height="8"
						viewBox="0 0 12 12"
						className="opacity-0 group-hover/close:opacity-100 transition-opacity duration-150 text-black/50"
						aria-hidden="true"
					>
						<path
							d="M3.5 3.5L8.5 8.5M8.5 3.5L3.5 8.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				</button>
				<button
					type="button"
					className="tauri-no-drag w-3 h-3 rounded-full bg-[#febc2e] flex items-center justify-center p-0 border-none cursor-pointer transition-[filter] duration-150 group/minimize hover:brightness-90"
					onClick={handleMinimize}
					aria-label="Minimize"
				>
					<svg
						width="8"
						height="8"
						viewBox="0 0 12 12"
						className="opacity-0 group-hover/minimize:opacity-100 transition-opacity duration-150 text-black/50"
						aria-hidden="true"
					>
						<path
							d="M2.5 6H9.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
						/>
					</svg>
				</button>
				<button
					type="button"
					className="tauri-no-drag w-3 h-3 rounded-full bg-[#28c840] flex items-center justify-center p-0 border-none cursor-pointer transition-[filter] duration-150 group/maximize hover:brightness-90"
					onClick={handleMaximize}
					aria-label="Maximize"
				>
					<svg
						width="8"
						height="8"
						viewBox="0 0 12 12"
						className="opacity-0 group-hover/maximize:opacity-100 transition-opacity duration-150 text-black/50"
						aria-hidden="true"
					>
						{isMaximized ? (
							<path
								d="M3 5L6 2L9 5M3 7L6 10L9 7"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						) : (
							<path
								d="M2.5 5L6 2L9.5 5M2.5 7L6 10L9.5 7"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						)}
					</svg>
				</button>
			</div>
		);
	}

	// Windows/Linux controls on the right
	return (
		<div className="flex items-center h-full pointer-events-auto">
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
