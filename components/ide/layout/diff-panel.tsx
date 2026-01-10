"use client";

import {
	PanelControls,
	type PanelState,
} from "@/components/ide/panel-controls";
import { TabbedDiffView } from "@/components/ide/tabbed-diff-view";
import type { FileNode } from "@/lib/api-types";

interface DiffPanelProps {
	isVisible: boolean;
	panelState: PanelState;
	style: React.CSSProperties;
	openFiles: FileNode[];
	activeFileId: string | null;
	onTabSelect: (file: FileNode) => void;
	onTabClose: (fileId: string) => void;
	onMinimize: () => void;
	onMaximize: () => void;
	onClose: () => void;
}

export function DiffPanel({
	isVisible,
	panelState,
	style,
	openFiles,
	activeFileId,
	onTabSelect,
	onTabClose,
	onMinimize,
	onMaximize,
	onClose,
}: DiffPanelProps) {
	if (!isVisible) return null;

	return (
		<div
			className="flex flex-col border-b border-border transition-all overflow-hidden"
			style={style}
		>
			<div className="h-10 flex items-center justify-between px-2 bg-muted/30 border-b border-border shrink-0">
				<span className="text-sm font-medium text-muted-foreground px-2">
					Files
				</span>
				<PanelControls
					state={panelState}
					onMinimize={onMinimize}
					onMaximize={onMaximize}
					onClose={onClose}
					showClose
				/>
			</div>
			{panelState !== "minimized" && (
				<TabbedDiffView
					openFiles={openFiles}
					activeFileId={activeFileId}
					onTabSelect={onTabSelect}
					onTabClose={onTabClose}
					className="flex-1 overflow-hidden"
					hideEmptyState
				/>
			)}
		</div>
	);
}
