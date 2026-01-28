import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { getWorkspaceShortName } from "@/components/ide/workspace-path";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { Workspace } from "@/lib/api-types";

interface DeleteWorkspaceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspace: Workspace | null;
	onConfirm: (deleteFiles: boolean) => void;
}

export function DeleteWorkspaceDialog({
	open,
	onOpenChange,
	workspace,
	onConfirm,
}: DeleteWorkspaceDialogProps) {
	const [deleteFiles, setDeleteFiles] = React.useState(false);
	const [isDeleting, setIsDeleting] = React.useState(false);

	// Reset state when dialog opens
	React.useEffect(() => {
		if (open) {
			setDeleteFiles(false);
			setIsDeleting(false);
		}
	}, [open]);

	const handleConfirm = async () => {
		setIsDeleting(true);
		try {
			onConfirm(deleteFiles);
		} finally {
			setIsDeleting(false);
		}
	};

	if (!workspace) return null;

	const displayName = getWorkspaceShortName(
		workspace.path,
		workspace.sourceType,
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AlertTriangle className="h-5 w-5 text-destructive" />
						Delete Workspace
					</DialogTitle>
					<DialogDescription>
						Are you sure you want to delete &quot;{displayName}&quot;? This will
						remove the workspace and all its sessions from Octobot.
					</DialogDescription>
				</DialogHeader>

				<div className="py-4 space-y-4">
					<div className="flex items-start gap-3">
						<Checkbox
							id="deleteFiles"
							checked={deleteFiles}
							onCheckedChange={(checked) => setDeleteFiles(checked === true)}
						/>
						<div className="grid gap-1.5 leading-none">
							<label
								htmlFor="deleteFiles"
								className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
							>
								Also delete files from disk
							</label>
							{workspace.workDir && (
								<p className="text-xs text-muted-foreground font-mono break-all">
									{workspace.workDir}
								</p>
							)}
						</div>
					</div>

					{deleteFiles && (
						<div className="rounded-md bg-destructive/10 border border-destructive/20 p-3">
							<p className="text-sm text-destructive">
								Warning: This will permanently delete all files in this
								workspace. This action cannot be undone.
							</p>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleConfirm}
						disabled={isDeleting}
					>
						{isDeleting ? "Deleting..." : "Delete Workspace"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
