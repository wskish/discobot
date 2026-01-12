"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { CreateWorkspaceRequest } from "@/lib/api-types";
import { WorkspaceForm, type WorkspaceFormRef } from "./workspace-form";

interface AddWorkspaceDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdd: (workspace: CreateWorkspaceRequest) => void;
}

export function AddWorkspaceDialog({
	open,
	onOpenChange,
	onAdd,
}: AddWorkspaceDialogProps) {
	const formRef = React.useRef<WorkspaceFormRef>(null);
	const [isValid, setIsValid] = React.useState(false);

	const handleSubmit = () => {
		formRef.current?.submit();
	};

	const handleFormSubmit = (workspace: CreateWorkspaceRequest) => {
		onAdd(workspace);
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Add Workspace</DialogTitle>
				</DialogHeader>
				<div className="py-4">
					<WorkspaceForm
						ref={formRef}
						onSubmit={handleFormSubmit}
						onValidationChange={setIsValid}
					/>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={!isValid}>
						Add Workspace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
