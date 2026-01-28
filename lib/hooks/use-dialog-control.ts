import { useCallback, useState } from "react";

/**
 * Generic hook for managing dialog open/close state with optional associated data.
 *
 * @example
 * // Simple dialog without data
 * const confirmDialog = useDialogControl();
 * confirmDialog.open();
 * confirmDialog.close();
 *
 * @example
 * // Dialog with associated data
 * const editDialog = useDialogControl<User>();
 * editDialog.open(user);
 * console.log(editDialog.data); // User object
 */
export function useDialogControl<T = void>() {
	const [isOpen, setIsOpen] = useState(false);
	const [data, setData] = useState<T | null>(null);

	const open = useCallback((openData?: T) => {
		setData((openData ?? null) as T | null);
		setIsOpen(true);
	}, []);

	const close = useCallback(() => {
		setIsOpen(false);
		setData(null);
	}, []);

	const onOpenChange = useCallback(
		(open: boolean) => {
			if (!open) {
				close();
			} else {
				setIsOpen(true);
			}
		},
		[close],
	);

	return { isOpen, data, open, close, onOpenChange };
}

export type DialogControl<T = void> = ReturnType<typeof useDialogControl<T>>;
