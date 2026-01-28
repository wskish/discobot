"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
	onResize: (delta: number) => void;
	orientation?: "horizontal" | "vertical";
	className?: string;
}

export function ResizeHandle({
	onResize,
	orientation = "horizontal",
	className,
}: ResizeHandleProps) {
	const [isDragging, setIsDragging] = React.useState(false);
	const startPosRef = React.useRef(0);

	const isVertical = orientation === "vertical";

	const handleMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
		setIsDragging(true);
		startPosRef.current = isVertical ? e.clientX : e.clientY;
	};

	React.useEffect(() => {
		if (!isDragging) return;

		const handleMouseMove = (e: MouseEvent) => {
			const currentPos = isVertical ? e.clientX : e.clientY;
			const delta = currentPos - startPosRef.current;
			startPosRef.current = currentPos;
			onResize(delta);
		};

		const handleMouseUp = () => {
			setIsDragging(false);
		};

		document.addEventListener("mousemove", handleMouseMove);
		document.addEventListener("mouseup", handleMouseUp);

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
		};
	}, [isDragging, isVertical, onResize]);

	const decreaseKey = isVertical ? "ArrowLeft" : "ArrowUp";
	const increaseKey = isVertical ? "ArrowRight" : "ArrowDown";

	return (
		// biome-ignore lint/a11y/useSemanticElements: Custom resize handle requires div for drag styling
		<div
			role="separator"
			aria-orientation={orientation}
			aria-valuenow={50}
			aria-valuemin={0}
			aria-valuemax={100}
			tabIndex={0}
			className={cn(
				"absolute z-10 transition-colors",
				isVertical
					? "top-0 bottom-0 -right-0.5 w-1 hover:w-2 cursor-col-resize"
					: "left-0 right-0 -bottom-0.5 h-1 hover:h-2 cursor-row-resize",
				"hover:bg-primary/20",
				isDragging && "bg-primary/30",
				isDragging && (isVertical ? "w-2" : "h-2"),
				className,
			)}
			onMouseDown={handleMouseDown}
			onKeyDown={(e) => {
				if (e.key === decreaseKey) {
					onResize(-10);
				} else if (e.key === increaseKey) {
					onResize(10);
				}
			}}
		/>
	);
}
