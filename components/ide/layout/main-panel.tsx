import {
	ChevronLeft,
	ChevronRight,
	FileCode,
	FileMinus,
	FilePlus,
	GitCommitHorizontal,
	Loader2,
	PanelRightClose,
	RefreshCw,
	Square,
	X,
} from "lucide-react";
import * as React from "react";
import { ChatPanel } from "@/components/ide/chat-panel";
import { IDELauncher } from "@/components/ide/ide-launcher";
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
import type { ActiveView, FileNode } from "@/lib/api-types";
import { useMainPanelContext } from "@/lib/contexts/main-panel-context";
import { useServices } from "@/lib/hooks/use-services";
import { cn } from "@/lib/utils";

interface MainPanelProps {
	view: ActiveView;
	onViewChange: (view: ActiveView) => void;
	rightSidebarOpen?: boolean;
	onToggleRightSidebar?: () => void;
	changedFilesCount?: number;
	openFiles?: FileNode[];
	onTabClose?: (fileId: string) => void;
	diffContent?: React.ReactNode;
}

export function MainPanel({
	view,
	onViewChange,
	rightSidebarOpen,
	onToggleRightSidebar,
	changedFilesCount = 0,
	openFiles = [],
	onTabClose,
	diffContent,
}: MainPanelProps) {
	const { getSelectedSessionId, selectedSession } = useMainPanelContext();
	const selectedSessionId = getSelectedSessionId();

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

	// Extract active file path from view
	const activeFilePath = view.startsWith("file:") ? view.slice(5) : null;

	// File tabs scroll state
	const tabsContainerRef = React.useRef<HTMLDivElement>(null);
	const [showScrollLeft, setShowScrollLeft] = React.useState(false);
	const [showScrollRight, setShowScrollRight] = React.useState(false);

	// Check scroll overflow
	const checkScrollOverflow = React.useCallback(() => {
		const container = tabsContainerRef.current;
		if (!container) return;

		const { scrollLeft, scrollWidth, clientWidth } = container;
		setShowScrollLeft(scrollLeft > 0);
		setShowScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
	}, []);

	// Update scroll state on mount, resize, and file changes
	React.useEffect(() => {
		checkScrollOverflow();

		const container = tabsContainerRef.current;
		if (!container) return;

		const resizeObserver = new ResizeObserver(checkScrollOverflow);
		resizeObserver.observe(container);

		container.addEventListener("scroll", checkScrollOverflow);

		return () => {
			resizeObserver.disconnect();
			container.removeEventListener("scroll", checkScrollOverflow);
		};
	}, [checkScrollOverflow]);

	// Scroll handler with continuous scrolling on hold
	const scrollIntervalRef = React.useRef<number | null>(null);

	const startScrolling = React.useCallback((direction: "left" | "right") => {
		const container = tabsContainerRef.current;
		if (!container) return;

		// Immediate first scroll
		const scrollAmount = 100;
		container.scrollBy({
			left: direction === "left" ? -scrollAmount : scrollAmount,
			behavior: "smooth",
		});

		// Clear any existing interval
		if (scrollIntervalRef.current) {
			clearInterval(scrollIntervalRef.current);
		}

		// Continue scrolling while held
		scrollIntervalRef.current = window.setInterval(() => {
			if (container) {
				container.scrollBy({
					left: direction === "left" ? -scrollAmount : scrollAmount,
					behavior: "smooth",
				});
			}
		}, 150);
	}, []);

	const stopScrolling = React.useCallback(() => {
		if (scrollIntervalRef.current) {
			clearInterval(scrollIntervalRef.current);
			scrollIntervalRef.current = null;
		}
	}, []);

	// Cleanup interval on unmount
	React.useEffect(() => {
		return () => {
			if (scrollIntervalRef.current) {
				clearInterval(scrollIntervalRef.current);
			}
		};
	}, []);

	return (
		<div className="flex flex-col overflow-hidden flex-1">
			{/* Main panel header with view tabs */}
			<div className="h-10 flex items-center justify-between bg-background border-b border-border shrink-0">
				<div className="flex items-center gap-0 flex-1 min-w-0 h-full overflow-hidden">
					<Button
						variant={view === "chat" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs mx-2 shrink-0"
						onClick={() => onViewChange("chat")}
					>
						Chat
					</Button>
					<Button
						variant={view === "terminal" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs shrink-0"
						onClick={() => onViewChange("terminal")}
					>
						Terminal
					</Button>
					{selectedSessionId && (
						<div className="shrink-0">
							<IDELauncher sessionId={selectedSessionId} />
						</div>
					)}
					{selectedSessionId &&
						services.map((service) => (
							<div key={service.id} className="shrink-0">
								<ServiceButton
									service={service}
									sessionId={selectedSessionId}
									isActive={activeServiceId === service.id}
									onSelect={() => onViewChange(`service:${service.id}`)}
									onStart={() => startService(service.id)}
								/>
							</div>
						))}

					{/* File tabs */}
					{openFiles.length > 0 && (
						<>
							<div className="w-px h-6 bg-border mx-2 shrink-0" />
							<div className="relative flex items-center min-w-0 h-full">
								{showScrollLeft && (
									<Button
										variant="ghost"
										size="icon"
										className="absolute left-0 h-6 w-6 z-10 bg-muted/95 hover:bg-muted shrink-0"
										onMouseDown={() => startScrolling("left")}
										onMouseUp={stopScrolling}
										onMouseLeave={stopScrolling}
										onTouchStart={() => startScrolling("left")}
										onTouchEnd={stopScrolling}
									>
										<ChevronLeft className="h-3.5 w-3.5" />
									</Button>
								)}
								<div
									ref={tabsContainerRef}
									className="flex items-center overflow-x-auto min-w-0 h-full scrollbar-none"
								>
									{openFiles.map((file) => (
										<div
											key={file.id}
											role="tab"
											tabIndex={0}
											aria-selected={activeFilePath === file.id}
											className={cn(
												"flex items-center gap-2 px-3 h-full border-r border-border cursor-pointer transition-colors text-sm shrink-0",
												activeFilePath === file.id
													? "bg-background text-foreground"
													: "text-muted-foreground hover:bg-muted/50",
											)}
											onClick={() => onViewChange(`file:${file.id}`)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													onViewChange(`file:${file.id}`);
												}
											}}
										>
											{file.status === "deleted" ? (
												<FileMinus className="h-4 w-4 text-red-500" />
											) : file.status === "added" ? (
												<FilePlus className="h-4 w-4 text-green-500" />
											) : (
												<FileCode
													className={cn(
														"h-4 w-4",
														file.status === "modified"
															? "text-yellow-500"
															: file.changed
																? "text-yellow-500"
																: "text-sky-500",
													)}
												/>
											)}
											<span
												className={cn(
													"truncate max-w-32",
													file.status === "deleted" &&
														"line-through text-muted-foreground",
												)}
											>
												{file.name}
											</span>
											{file.status && (
												<span
													className={cn(
														"text-xs font-medium",
														file.status === "added" && "text-green-500",
														file.status === "modified" && "text-yellow-500",
														file.status === "deleted" && "text-red-500",
														file.status === "renamed" && "text-purple-500",
													)}
												>
													{file.status === "added"
														? "A"
														: file.status === "modified"
															? "M"
															: file.status === "deleted"
																? "D"
																: file.status === "renamed"
																	? "R"
																	: ""}
												</span>
											)}
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													onTabClose?.(file.id);
												}}
												className="hover:bg-muted-foreground/20 rounded p-0.5 transition-colors"
											>
												<X className="h-3.5 w-3.5" />
											</button>
										</div>
									))}
								</div>
								{showScrollRight && (
									<Button
										variant="ghost"
										size="icon"
										className="absolute right-0 h-6 w-6 z-10 bg-muted/95 hover:bg-muted shrink-0"
										onMouseDown={() => startScrolling("right")}
										onMouseUp={stopScrolling}
										onMouseLeave={stopScrolling}
										onTouchStart={() => startScrolling("right")}
										onTouchEnd={stopScrolling}
									>
										<ChevronRight className="h-3.5 w-3.5" />
									</Button>
								)}
							</div>
						</>
					)}
				</div>
				<div className="flex items-center gap-2">
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
			<div
				className={cn(
					"flex-1 overflow-hidden relative",
					!selectedSessionId && "flex items-center justify-center",
				)}
			>
				{/* Chat panel - always mounted */}
				<div
					className={cn(
						"absolute inset-0",
						view !== "chat" && "invisible pointer-events-none",
						!selectedSessionId && "static", // Remove absolute positioning for centered layout
					)}
				>
					<ChatPanel
						className={cn(
							"h-full",
							!selectedSessionId && "w-full max-w-none", // Full width when centered
						)}
					/>
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
					services
						.filter((s) => mountedServices.has(s.id))
						.map((service) => (
							<div
								key={service.id}
								className={cn(
									"absolute inset-0",
									activeServiceId !== service.id &&
										"invisible pointer-events-none",
								)}
							>
								<ServiceView
									sessionId={selectedSessionId}
									service={service}
									className="h-full"
								/>
							</div>
						))}
				{/* File diff content - rendered for any file: view */}
				{diffContent && (
					<div
						className={cn(
							"absolute inset-0 flex flex-col",
							!activeFilePath && "invisible pointer-events-none",
						)}
					>
						{diffContent}
					</div>
				)}
			</div>
		</div>
	);
}
