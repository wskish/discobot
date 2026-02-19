import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { Route, Routes } from "react-router";
import { AppShell } from "@/components/app-shell";
import { ResizeObserverFix } from "@/components/resize-observer-fix";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isTauri } from "@/lib/api-config";
import { HomePage } from "./pages/HomePage";

// Lazy load UpdateProvider only for Tauri
const UpdateProvider = lazy(() =>
	import("@/lib/contexts/update-context").then((mod) => ({
		default: mod.UpdateProvider,
	})),
);

function MaybeUpdateProvider({ children }: { children: ReactNode }) {
	if (!isTauri()) return <>{children}</>;
	return (
		<Suspense fallback={children}>
			<UpdateProvider>{children}</UpdateProvider>
		</Suspense>
	);
}

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
				<Toaster />
				<MaybeUpdateProvider>
					<AppShell>
						<Routes>
							<Route path="/" element={<HomePage />} />
						</Routes>
					</AppShell>
				</MaybeUpdateProvider>
			</TooltipProvider>
		</ThemeProvider>
	);
}
