"use client";

import {
	GitCommitHorizontal,
	Loader2,
	PanelRightClose,
	RefreshCw,
	Square,
} from "lucide-react";
import * as React from "react";
import { ChatPanel } from "@/components/ide/chat-panel";
import { IDELauncher } from "@/components/ide/ide-launcher";
import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
import { ServiceButton } from "@/components/ide/service-button";
import { ServiceView } from "@/components/ide/service-view";
import {
	type ConnectionStatus,
	TerminalView,
	type TerminalViewHandle,
} from "@/components/ide/terminal-view";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { CommitStatus } from "@/lib/api-constants";
import { useSessionContext } from "@/lib/contexts/session-context";
import { useServices } from "@/lib/hooks/use-services";
import { cn } from "@/lib/utils";

type BottomView = "chat" | "terminal" | `service:${string}`;

interface BottomPanelProps {
	panelState: PanelState;
	style: React.CSSProperties;
	showPanelControls: boolean;
	view: BottomView;
	onViewChange: (view: BottomView) => void;
	onMinimize: () => void;
	rightSidebarOpen?: boolean;
	onToggleRightSidebar?: () => void;
	changedFilesCount?: number;
}

export function BottomPanel({
	panelState,
	style,
	showPanelControls,
	view,
	onViewChange,
	onMinimize,
	rightSidebarOpen,
	onToggleRightSidebar,
	changedFilesCount = 0,
}: BottomPanelProps) {
	const { selectedSessionId, selectedSession } = useSessionContext();

	// Track whether terminal has ever been viewed (for lazy loading)
	const [terminalMounted, setTerminalMounted] = React.useState(false);
	// Track root mode for terminal
	const [terminalRoot, setTerminalRoot] = React.useState(false);
	// Track terminal connection status
	const [terminalStatus, setTerminalStatus] =
		React.useState<ConnectionStatus>("disconnected");
	// Ref for terminal to call reconnect
	const terminalRef = React.useRef<TerminalViewHandle>(null);
	// Track commit state
	const [isCommitting, setIsCommitting] = React.useState(false);

	// Services hook
	const { services, startService, stopService } =
		useServices(selectedSessionId);

	// Extract active service from view
	const activeServiceId = view.startsWith("service:") ? view.slice(8) : null;
	const activeService = services.find((s) => s.id === activeServiceId);

	// Track which services have been viewed (for lazy loading)
	const [mountedServices, setMountedServices] = React.useState<Set<string>>(
		new Set(),
	);

	// Mount terminal when first viewed
	React.useEffect(() => {
		if (view === "terminal" && !terminalMounted) {
			setTerminalMounted(true);
		}
	}, [view, terminalMounted]);

	// Mount service output when first viewed
	React.useEffect(() => {
		if (activeServiceId && !mountedServices.has(activeServiceId)) {
			setMountedServices((prev) => new Set(prev).add(activeServiceId));
		}
	}, [activeServiceId, mountedServices]);

	// Handle commit button click
	const handleCommit = React.useCallback(async () => {
		if (!selectedSessionId || isCommitting) return;

		try {
			setIsCommitting(true);
			await api.commitSession(selectedSessionId);
		} catch (error) {
			console.error("Failed to start commit:", error);
		} finally {
			setIsCommitting(false);
		}
	}, [selectedSessionId, isCommitting]);

	// Check if session is in a commit state
	const isSessionCommitting =
		selectedSession?.commitStatus === CommitStatus.PENDING ||
		selectedSession?.commitStatus === CommitStatus.COMMITTING;
	const showCommitLoading = isCommitting || isSessionCommitting;

	return (
		<div className="flex flex-col overflow-hidden" style={style}>
			{/* Bottom panel header */}
			<div className="h-10 flex items-center justify-between px-2 bg-muted/30 border-b border-border shrink-0">
				<div className="flex items-center gap-2">
					<Button
						variant={view === "chat" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs"
						onClick={() => onViewChange("chat")}
					>
						Chat
					</Button>
					<Button
						variant={view === "terminal" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs"
						onClick={() => onViewChange("terminal")}
					>
						Terminal
					</Button>
					{selectedSessionId && <IDELauncher sessionId={selectedSessionId} />}
					{selectedSessionId &&
						services.map((service) => (
							<ServiceButton
								key={service.id}
								service={service}
								sessionId={selectedSessionId}
								isActive={activeServiceId === service.id}
								onSelect={() => onViewChange(`service:${service.id}`)}
								onStart={() => startService(service.id)}
							/>
						))}
				</div>
				<div className="flex items-center gap-2">
					{showPanelControls && (
						<PanelControls
							state={panelState}
							onMinimize={onMinimize}
							showMinimize={false}
							showMaximize={false}
						/>
					)}
					{activeService && activeService.status === "running" && (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 text-xs gap-1"
							onClick={() => stopService(activeService.id)}
							title="Stop service"
						>
							<Square className="h-3 w-3 fill-current" />
							Stop
						</Button>
					)}
					{view === "terminal" && (
						<>
							{(terminalStatus === "disconnected" ||
								terminalStatus === "error") && (
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-xs gap-1"
									onClick={() => terminalRef.current?.reconnect()}
								>
									<RefreshCw className="h-3 w-3" />
									Reconnect
								</Button>
							)}
							<label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
								<input
									type="checkbox"
									checked={terminalRoot}
									onChange={(e) => setTerminalRoot(e.target.checked)}
									className="h-3 w-3 cursor-pointer"
								/>
								root
							</label>
						</>
					)}
					{changedFilesCount > 0 && (
						<Button
							variant="default"
							size="sm"
							className="h-6 text-xs gap-1"
							onClick={handleCommit}
							disabled={showCommitLoading || !selectedSessionId}
							title="Commit changes"
						>
							{showCommitLoading ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<GitCommitHorizontal className="h-3.5 w-3.5" />
							)}
							{showCommitLoading ? "Committing..." : "Commit"}
						</Button>
					)}
					{onToggleRightSidebar &&
						(rightSidebarOpen ? (
							<Button
								variant="ghost"
								size="icon"
								className="h-6 w-6"
								onClick={onToggleRightSidebar}
								title="Collapse Files"
							>
								<PanelRightClose className="h-3.5 w-3.5" />
							</Button>
						) : (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 text-xs"
								onClick={onToggleRightSidebar}
							>
								{changedFilesCount > 0
									? `Changes (${changedFilesCount})`
									: "Files"}
							</Button>
						))}
				</div>
			</div>
			{panelState !== "minimized" && (
				<div className="flex-1 overflow-hidden relative">
					{/* Chat panel - always mounted */}
					<div
						className={cn(
							"absolute inset-0",
							view !== "chat" && "invisible pointer-events-none",
						)}
					>
						<ChatPanel key={selectedSessionId} className="h-full" />
					</div>
					{/* Terminal - lazy mounted, stays mounted once viewed */}
					{terminalMounted && (
						<div
							className={cn(
								"absolute inset-0",
								view !== "terminal" && "invisible pointer-events-none",
							)}
						>
							<TerminalView
								ref={terminalRef}
								sessionId={selectedSessionId}
								root={terminalRoot}
								className="h-full"
								onToggleChat={() => onViewChange("chat")}
								hideHeader
								onConnectionStatusChange={setTerminalStatus}
							/>
						</div>
					)}
					{/* Service views - lazy mounted, stay mounted once viewed */}
					{selectedSessionId &&
						Array.from(mountedServices).map((serviceId) => {
							const service = services.find((s) => s.id === serviceId);
							if (!service) return null;
							return (
								<div
									key={serviceId}
									className={cn(
										"absolute inset-0",
										activeServiceId !== serviceId &&
											"invisible pointer-events-none",
									)}
								>
									<ServiceView
										sessionId={selectedSessionId}
										service={service}
										className="h-full"
									/>
								</div>
							);
						})}
				</div>
			)}
		</div>
	);
}
