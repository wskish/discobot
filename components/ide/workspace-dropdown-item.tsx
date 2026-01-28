"use client";

import { Check, Trash2, X } from "lucide-react";
import type * as React from "react";
import { WorkspaceDisplay } from "@/components/ide/workspace-display";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { Workspace } from "@/lib/api-types";

interface WorkspaceDropdownItemProps {
	workspace: Workspace;
	isSelected: boolean;
	isConfirming: boolean;
	onSelect: () => void;
	onDeleteClick: (e: React.MouseEvent) => void;
	onConfirmDelete: (e: React.MouseEvent) => void;
	onCancelDelete: (e: React.MouseEvent) => void;
}

export function WorkspaceDropdownItem({
	workspace,
	isSelected,
	isConfirming,
	onSelect,
	onDeleteClick,
	onConfirmDelete,
	onCancelDelete,
}: WorkspaceDropdownItemProps) {
	return (
		<DropdownMenuItem
			onClick={onSelect}
			className="group/item flex items-center gap-2"
		>
			<WorkspaceDisplay
				workspace={workspace}
				iconSize={16}
				iconClassName="h-4 w-4"
				textClassName="truncate"
				className="flex-1"
				showTooltip={false}
			/>
			{isSelected && !isConfirming && (
				<Check className="h-4 w-4 shrink-0 text-primary" />
			)}
			{isConfirming ? (
				<InlineConfirmation
					onConfirm={onConfirmDelete}
					onCancel={onCancelDelete}
				/>
			) : (
				<button
					type="button"
					onClick={onDeleteClick}
					className="h-6 w-6 shrink-0 rounded hover:bg-destructive/10 hover:text-destructive flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity"
					title="Delete workspace"
				>
					<Trash2 className="h-3.5 w-3.5" />
				</button>
			)}
		</DropdownMenuItem>
	);
}

interface InlineConfirmationProps {
	onConfirm: (e: React.MouseEvent) => void;
	onCancel: (e: React.MouseEvent) => void;
}

function InlineConfirmation({ onConfirm, onCancel }: InlineConfirmationProps) {
	return (
		<div className="flex items-center gap-0.5 shrink-0">
			<button
				type="button"
				onClick={onConfirm}
				className="h-6 w-6 rounded hover:bg-destructive/10 text-destructive flex items-center justify-center"
				title="Confirm delete"
			>
				<Check className="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				onClick={onCancel}
				className="h-6 w-6 rounded hover:bg-muted flex items-center justify-center"
				title="Cancel"
			>
				<X className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}
