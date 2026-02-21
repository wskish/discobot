import { useEffect } from "react";

/**
 * This component suppresses benign Monaco Editor internal errors that occur
 * during component lifecycle transitions (mounting/unmounting).
 *
 * Monaco Editor's internal cursor tracking can try to access the model after
 * it has been disposed, causing "Cannot read properties of undefined" errors.
 * These are harmless race conditions that don't affect functionality.
 *
 * Common error patterns:
 * - "Cannot read properties of undefined (reading 'getModelColumnOfViewPosition')"
 * - Other model access errors during view position calculations
 */
export function MonacoEditorFix() {
	useEffect(() => {
		const handler = (e: ErrorEvent) => {
			// Check if this is a Monaco Editor internal error
			const message = e.message || "";
			const isMonacoError =
				message.includes("getModelColumnOfViewPosition") ||
				message.includes("convertViewPositionToModelPosition");

			if (isMonacoError) {
				// Suppress the error - it's a benign race condition
				e.stopImmediatePropagation();
				e.preventDefault();
			}
		};

		window.addEventListener("error", handler);
		return () => window.removeEventListener("error", handler);
	}, []);

	return null;
}
