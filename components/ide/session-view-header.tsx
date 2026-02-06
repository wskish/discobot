import {
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
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
import { IDELauncher } from "@/components/ide/ide-launcher";
import { ServiceButton } from "@/components/ide/service-button";
import { Button } from "@/components/ui/button";
import { CommitStatus } from "@/lib/api-constants";
import { useSessionViewContext } from "@/lib/contexts/session-view-context";
import { useSessionFiles } from "@/lib/hooks/use-session-files";
import { cn } from "@/lib/utils";

/**
 * Get the SSH host from the current location.
 */
function getSSHHost(): string {
	if (typeof window === "undefined") return "localhost";
	const hostname = window.location.hostname;
	if (hostname === "127.0.0.1" || hostname === "::1") return "localhost";
	return hostname;
}

export function SessionViewHeader() {
	const {
		selectedSessionId,
		selectedSession,
		activeView,
		setActiveView,
		openFiles,
		activeFilePathFromView,
		handleTabClose,
		terminalRoot,
		terminalStatus,
		terminalRef,
		setTerminalRoot,
		services,
		activeServiceId,
		startService,
		stopService,
		isCommitting,
		handleCommit,
		rightSidebarOpen,
		changedFilesCount = 0,
		onToggleRightSidebar,
	} = useSessionViewContext();
	const activeService = services.find((s) => s.id === activeServiceId);

	// Get diff stats for the "All Changes" button
	const { diffStats } = useSessionFiles(selectedSessionId, false);

	// Check if session is in a commit state
	const isSessionCommitting =
		selectedSession?.commitStatus === CommitStatus.PENDING ||
		selectedSession?.commitStatus === CommitStatus.COMMITTING;
	const showCommitLoading = isCommitting || isSessionCommitting;

	// Terminal reconnect handler
	const handleTerminalReconnect = React.useCallback(() => {
		terminalRef.current?.reconnect();
	}, [terminalRef]);

	// SSH copy state and handler
	const [copied, setCopied] = React.useState(false);

	const handleCopySSH = React.useCallback(async () => {
		if (!selectedSessionId) return;

		const host = getSSHHost();
		const sshLocation = `ssh -p 3333 ${selectedSessionId}@${host}`;

		try {
			await navigator.clipboard.writeText(sshLocation);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (error) {
			console.error("Failed to copy SSH location:", error);
		}
	}, [selectedSessionId]);

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
		<div
			className={cn(
				"h-10 flex items-center justify-between bg-background shrink-0",
				selectedSession && "border-b border-border",
			)}
		>
			{selectedSession && (
				<div className="flex items-center gap-0 flex-1 min-w-0 h-full overflow-hidden animate-in fade-in duration-500">
					<Button
						variant={activeView === "chat" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs mx-2 shrink-0"
						onClick={() => setActiveView("chat")}
					>
						Chat
					</Button>
					<Button
						variant={activeView === "terminal" ? "secondary" : "ghost"}
						size="sm"
						className="h-6 text-xs shrink-0"
						onClick={() => setActiveView("terminal")}
					>
						Terminal
					</Button>
					{diffStats && diffStats.filesChanged > 0 && (
						<Button
							variant={
								activeView === "consolidated-diff" ? "secondary" : "ghost"
							}
							size="sm"
							className="h-6 text-xs shrink-0 gap-1"
							onClick={() => setActiveView("consolidated-diff")}
						>
							<span className="text-green-500">+{diffStats.additions}</span>
							<span className="text-red-500">-{diffStats.deletions}</span>
						</Button>
					)}
					{selectedSessionId &&
						services.map((service) => (
							<div key={service.id} className="shrink-0">
								<ServiceButton
									service={service}
									sessionId={selectedSessionId}
									isActive={activeServiceId === service.id}
									onSelect={() => setActiveView(`service:${service.id}`)}
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
											aria-selected={activeFilePathFromView === file.id}
											className={cn(
												"flex items-center gap-2 px-3 h-full border-r border-border cursor-pointer transition-colors text-sm shrink-0",
												activeFilePathFromView === file.id
													? "bg-background text-foreground"
													: "text-muted-foreground hover:bg-muted/50",
											)}
											onClick={() => setActiveView(`file:${file.id}`)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													setActiveView(`file:${file.id}`);
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
													handleTabClose(file.id);
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
			)}
			{selectedSession && (
				<div className="flex items-center gap-2 animate-in fade-in duration-500">
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
					{activeView === "terminal" && (
						<>
							{(terminalStatus === "disconnected" ||
								terminalStatus === "error") && (
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-xs gap-1"
									onClick={handleTerminalReconnect}
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
							{selectedSessionId && (
								<Button
									variant="ghost"
									size="sm"
									onClick={handleCopySSH}
									className="h-6 text-xs gap-1"
									title={`Copy SSH command: ssh -p 3333 ${selectedSessionId}@${getSSHHost()}`}
								>
									{copied ? (
										<Check className="h-3 w-3" />
									) : (
										<Copy className="h-3 w-3" />
									)}
									{copied ? "Copied!" : "Copy SSH"}
								</Button>
							)}
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
					{selectedSessionId && (
						<div className="shrink-0">
							<IDELauncher sessionId={selectedSessionId} />
						</div>
					)}
					{onToggleRightSidebar && (
						<Button
							variant="ghost"
							size={rightSidebarOpen ? "icon" : "sm"}
							className={cn("h-6", rightSidebarOpen ? "w-6" : "text-xs")}
							onClick={onToggleRightSidebar}
							title={rightSidebarOpen ? "Close Files" : "Open Files"}
						>
							{rightSidebarOpen ? (
								<PanelRightClose className="h-3.5 w-3.5" />
							) : (
								"Files"
							)}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
