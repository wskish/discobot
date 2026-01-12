"use client";

import { AlertTriangle, XCircle } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { StatusMessage } from "@/lib/api-types";
import { cn } from "@/lib/utils";

interface SystemRequirementsDialogProps {
	open: boolean;
	messages: StatusMessage[];
	onClose: () => void;
}

/**
 * Dialog shown when system requirements are not met.
 * Displays warnings or errors about missing dependencies like Docker or Git.
 */
export function SystemRequirementsDialog({
	open,
	messages,
	onClose,
}: SystemRequirementsDialogProps) {
	const hasErrors = messages.some((m) => m.level === "error");

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="h-5 w-5 text-yellow-500" />
						System Requirements
					</DialogTitle>
					<DialogDescription>
						{hasErrors
							? "Some required dependencies are missing. Please install them to continue."
							: "Some optional dependencies are missing. You can continue, but some features may not work."}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3 py-4">
					{messages.map((message) => (
						<div
							key={message.id}
							className={cn(
								"flex gap-3 p-3 rounded-lg border",
								message.level === "error"
									? "bg-destructive/10 border-destructive/20"
									: "bg-yellow-500/10 border-yellow-500/20",
							)}
						>
							{message.level === "error" ? (
								<XCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
							) : (
								<AlertTriangle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
							)}
							<div className="space-y-1">
								<p
									className={cn(
										"font-medium text-sm",
										message.level === "error"
											? "text-destructive"
											: "text-yellow-600 dark:text-yellow-400",
									)}
								>
									{message.title}
								</p>
								<p className="text-sm text-muted-foreground">
									{message.message}
								</p>
							</div>
						</div>
					))}
				</div>

				<DialogFooter>
					{hasErrors ? (
						<Button variant="outline" onClick={onClose}>
							Close
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={onClose}>
								Continue Anyway
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
