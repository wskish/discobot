import { DialogLayer } from "@/components/ide/dialogs/dialog-layer";
import { Header } from "@/components/ide/layout/header";
import { LeftSidebar } from "@/components/ide/layout/left-sidebar";
import { MainContent } from "@/components/ide/layout/main-content";
import { StartupStatusBar } from "@/components/startup-status-bar";
import { AppProvider } from "@/lib/contexts/app-provider";
import { DialogProvider } from "@/lib/contexts/dialog-context";
import { usePageLayoutContext } from "@/lib/contexts/page-layout-context";

function IDEContent() {
	const {
		leftSidebarOpen,
		leftSidebarWidth,
		setLeftSidebarOpen,
		handleLeftSidebarResize,
	} = usePageLayoutContext();

	// Components render progressively - each handles its own loading state
	return (
		<div className="h-screen flex flex-col bg-background">
			<Header
				leftSidebarOpen={leftSidebarOpen}
				onToggleSidebar={() => setLeftSidebarOpen(!leftSidebarOpen)}
			/>
			<StartupStatusBar />

			<div className="flex-1 flex overflow-hidden">
				<LeftSidebar
					isOpen={leftSidebarOpen}
					width={leftSidebarWidth}
					onResize={handleLeftSidebarResize}
				/>
				<MainContent />
			</div>

			<DialogLayer />
		</div>
	);
}

export function HomePage() {
	return (
		<AppProvider>
			<DialogProvider>
				<IDEContent />
			</DialogProvider>
		</AppProvider>
	);
}
