import { useEffect } from "react";

// This component suppresses the benign "ResizeObserver loop" error
// which occurs when a ResizeObserver callback triggers layout changes
// This is a known browser behavior and doesn't indicate actual problems
export function ResizeObserverFix() {
	useEffect(() => {
		const handler = (e: ErrorEvent) => {
			if (
				e.message ===
				"ResizeObserver loop completed with undelivered notifications."
			) {
				e.stopImmediatePropagation();
			}
		};

		window.addEventListener("error", handler);
		return () => window.removeEventListener("error", handler);
	}, []);

	return null;
}
