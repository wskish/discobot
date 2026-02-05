import "./globals.css";

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ErrorBoundary } from "@/components/error-boundary";
import { initTauriConfig } from "@/lib/api-config";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Initialize Tauri config (sets auth cookie) before rendering
initTauriConfig().then(() => {
	// Remove loading screen
	const loadingScreen = document.getElementById("loading-screen");
	if (loadingScreen) {
		loadingScreen.remove();
	}

	createRoot(root).render(
		<ErrorBoundary>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</ErrorBoundary>,
	);
});
