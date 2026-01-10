"use client";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type PanelState = "normal" | "minimized" | "maximized";

interface PanelControlsProps {
	state: PanelState;
	onMinimize: () => void;
	onMaximize: () => void;
	onClose?: () => void;
	showClose?: boolean;
}

export function PanelControls({
	state,
	onMinimize,
	onMaximize,
	onClose,
	showClose = false,
}: PanelControlsProps) {
	return (
		<div className="flex items-center gap-1">
			{state === "minimized" ? (
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={onMinimize}
					title="Restore"
				>
					<ChevronDown className="h-3.5 w-3.5" />
				</Button>
			) : (
				<>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={onMinimize}
						title="Minimize"
					>
						<Minimize2 className="h-3.5 w-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={onMaximize}
						title={state === "maximized" ? "Restore" : "Maximize"}
					>
						{state === "maximized" ? (
							<ChevronUp className="h-3.5 w-3.5" />
						) : (
							<Maximize2 className="h-3.5 w-3.5" />
						)}
					</Button>
				</>
			)}
			{showClose && onClose && (
				<Button
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={onClose}
					title="Close"
				>
					<X className="h-3.5 w-3.5" />
				</Button>
			)}
		</div>
	);
}
