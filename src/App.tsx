import { useEffect } from "react";
import { Route, Routes } from "react-router";
import { AppShell } from "@/components/app-shell";
import { ResizeObserverFix } from "@/components/resize-observer-fix";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HomePage } from "./pages/HomePage";

export function App() {
	// Initialize theme attribute from localStorage on mount
	useEffect(() => {
		const saved = localStorage.getItem("theme.colorScheme") || "default";
		document.documentElement.setAttribute("data-theme", saved);
	}, []);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem
			disableTransitionOnChange
			storageKey="theme"
		>
			<TooltipProvider delayDuration={700}>
				<ResizeObserverFix />
				<AppShell>
					<Routes>
						<Route path="/" element={<HomePage />} />
					</Routes>
				</AppShell>
			</TooltipProvider>
		</ThemeProvider>
	);
}
