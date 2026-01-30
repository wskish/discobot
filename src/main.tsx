import "./globals.css";

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { initTauriConfig } from "@/lib/api-config";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Initialize Tauri config (sets auth cookie) before rendering
initTauriConfig().then(() => {
	createRoot(root).render(
		<BrowserRouter>
			<App />
		</BrowserRouter>,
	);
});
