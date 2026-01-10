"use client";

import { PanelLeft, PanelLeftClose, Plus } from "lucide-react";
import { ThemeToggle } from "@/components/ide/theme-toggle";
import { Button } from "@/components/ui/button";

interface HeaderProps {
	leftSidebarOpen: boolean;
	onToggleSidebar: () => void;
	onNewSession: () => void;
}

export function Header({
	leftSidebarOpen,
	onToggleSidebar,
	onNewSession,
}: HeaderProps) {
	return (
		<header className="h-12 border-b border-border flex items-center justify-between px-4">
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="icon" onClick={onToggleSidebar}>
					{leftSidebarOpen ? (
						<PanelLeftClose className="h-4 w-4" />
					) : (
						<PanelLeft className="h-4 w-4" />
					)}
				</Button>
				<span className="font-semibold">IDE Chat</span>
				<Button
					variant="ghost"
					size="sm"
					className="gap-1.5 text-muted-foreground"
					onClick={onNewSession}
				>
					<Plus className="h-4 w-4" />
					New Session
				</Button>
			</div>
			<div className="flex items-center gap-2">
				<ThemeToggle />
			</div>
		</header>
	);
}
