import { useEffect, useRef, useState } from "react";

/**
 * Hook that throttles a value, limiting how often it updates.
 * Useful for reducing render frequency during rapid updates (e.g., streaming messages).
 *
 * @param value - The value to throttle
 * @param delayMs - Minimum milliseconds between updates (default: 100ms)
 * @returns The throttled value
 */
export function useThrottle<T>(value: T, delayMs: number = 100): T {
	const [throttledValue, setThrottledValue] = useState<T>(value);
	const lastUpdateRef = useRef<number>(0);
	const timeoutRef = useRef<NodeJS.Timeout | null>(null);

	useEffect(() => {
		const now = Date.now();
		const timeSinceLastUpdate = now - lastUpdateRef.current;

		// Clear any pending timeout
		if (timeoutRef.current) {
			clearTimeout(timeoutRef.current);
		}

		// If enough time has passed, update immediately
		if (timeSinceLastUpdate >= delayMs) {
			lastUpdateRef.current = now;
			setThrottledValue(value);
		} else {
			// Otherwise, schedule an update for later
			timeoutRef.current = setTimeout(() => {
				lastUpdateRef.current = Date.now();
				setThrottledValue(value);
			}, delayMs - timeSinceLastUpdate);
		}

		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, [value, delayMs]);

	return throttledValue;
}
