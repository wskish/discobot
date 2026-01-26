"use client";

import * as React from "react";

/**
 * Hook that tracks whether an element has ever been visible in the viewport.
 * Once visible, it stays "activated" forever (useful for lazy rendering).
 *
 * @param options - IntersectionObserver options (rootMargin, threshold, etc.)
 * @returns [ref, hasBeenVisible] - Ref to attach to element, boolean for visibility state
 */
export function useLazyRender(
	options?: IntersectionObserverInit,
): [React.RefCallback<Element>, boolean] {
	const [hasBeenVisible, setHasBeenVisible] = React.useState(false);
	const observerRef = React.useRef<IntersectionObserver | null>(null);

	// Use a ref callback to handle element attachment/detachment
	const setRef = React.useCallback(
		(element: Element | null) => {
			// Cleanup previous observer
			if (observerRef.current) {
				observerRef.current.disconnect();
				observerRef.current = null;
			}

			// If already visible, no need to observe
			if (hasBeenVisible) return;

			// If no element, nothing to observe
			if (!element) return;

			// Create new observer
			observerRef.current = new IntersectionObserver((entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						setHasBeenVisible(true);
						// Once visible, we can stop observing
						observerRef.current?.disconnect();
						observerRef.current = null;
						break;
					}
				}
			}, options);

			observerRef.current.observe(element);
		},
		[hasBeenVisible, options],
	);

	// Cleanup on unmount
	React.useEffect(() => {
		return () => {
			if (observerRef.current) {
				observerRef.current.disconnect();
			}
		};
	}, []);

	return [setRef, hasBeenVisible];
}
