"use client";

import { Download, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ImageAttachmentProps {
	src: string;
	filename?: string;
	className?: string;
}

export function ImageAttachment({
	src,
	filename = "image",
	className,
}: ImageAttachmentProps) {
	const [isOpen, setIsOpen] = React.useState(false);
	const [zoom, setZoom] = React.useState(1);
	const [mounted, setMounted] = React.useState(false);
	const [naturalSize, setNaturalSize] = React.useState({ width: 0, height: 0 });
	const containerRef = React.useRef<HTMLDivElement>(null);

	// Ensure we only render portal on client
	React.useEffect(() => {
		setMounted(true);
	}, []);

	const handleDownload = () => {
		const link = document.createElement("a");
		link.href = src;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 4));
	const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.25));
	const resetZoom = () => setZoom(1);

	const handleClose = () => {
		setIsOpen(false);
		setZoom(1);
	};

	// Handle mouse wheel zoom
	const handleWheel = React.useCallback((e: WheelEvent) => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? -0.1 : 0.1;
		setZoom((z) => Math.min(Math.max(z + delta, 0.25), 4));
	}, []);

	// Attach wheel listener to the lightbox
	React.useEffect(() => {
		if (!isOpen) return;
		const container = containerRef.current;
		if (!container) return;

		container.addEventListener("wheel", handleWheel, { passive: false });
		return () => container.removeEventListener("wheel", handleWheel);
	}, [isOpen, handleWheel]);

	// Handle escape key
	// biome-ignore lint/correctness/useExhaustiveDependencies: handleClose is stable
	React.useEffect(() => {
		if (!isOpen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				handleClose();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen]);

	// Prevent body scroll when open
	React.useEffect(() => {
		if (isOpen) {
			document.body.style.overflow = "hidden";
		} else {
			document.body.style.overflow = "";
		}
		return () => {
			document.body.style.overflow = "";
		};
	}, [isOpen]);

	// Load natural image dimensions
	const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
	};

	// Calculate displayed size based on zoom
	// At zoom=1, fit within 85vw x 80vh
	// At zoom>1, scale up from there
	const getDisplaySize = () => {
		if (!naturalSize.width || !naturalSize.height) {
			return { width: "auto", height: "auto" };
		}

		const maxWidth = window.innerWidth * 0.85;
		const maxHeight = window.innerHeight * 0.8;

		// Calculate base size to fit within viewport at zoom=1
		const widthRatio = maxWidth / naturalSize.width;
		const heightRatio = maxHeight / naturalSize.height;
		const baseRatio = Math.min(widthRatio, heightRatio, 1); // Don't upscale past natural size at zoom=1

		const baseWidth = naturalSize.width * baseRatio;
		const baseHeight = naturalSize.height * baseRatio;

		// Apply zoom
		return {
			width: `${baseWidth * zoom}px`,
			height: `${baseHeight * zoom}px`,
		};
	};

	const displaySize = getDisplaySize();

	const lightbox =
		isOpen && mounted
			? createPortal(
					<div
						ref={containerRef}
						className="fixed inset-0 z-[100] overflow-auto"
						role="dialog"
						aria-modal="true"
						aria-label={`Image: ${filename}`}
					>
						{/* Overlay - fixed behind everything */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled separately */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: Overlay backdrop */}
						<div
							className="fixed inset-0 bg-black/90"
							onClick={handleClose}
						/>

						{/* Toolbar - fixed position */}
						<div className="fixed top-4 right-4 flex items-center gap-2 z-[102]">
							<Button
								variant="secondary"
								size="icon"
								onClick={handleZoomOut}
								disabled={zoom <= 0.25}
								className="size-9 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
								title="Zoom out"
							>
								<ZoomOut className="size-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={resetZoom}
								className="size-9 bg-white/10 hover:bg-white/20 text-white border-0 text-xs font-mono backdrop-blur-sm min-w-[4rem]"
								title="Reset zoom"
							>
								{Math.round(zoom * 100)}%
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={handleZoomIn}
								disabled={zoom >= 4}
								className="size-9 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
								title="Zoom in"
							>
								<ZoomIn className="size-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={handleDownload}
								className="size-9 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
								title="Download"
							>
								<Download className="size-4" />
							</Button>
							<Button
								variant="secondary"
								size="icon"
								onClick={handleClose}
								className="size-9 bg-white/10 hover:bg-white/20 text-white border-0 backdrop-blur-sm"
								title="Close (Esc)"
							>
								<X className="size-4" />
							</Button>
						</div>

						{/* Filename & zoom hint - fixed position */}
						<div className="fixed bottom-4 left-4 flex items-center gap-3 z-[102]">
							{filename && (
								<div className="text-white/70 text-sm bg-white/10 backdrop-blur-sm px-3 py-1.5 rounded-md">
									{filename}
								</div>
							)}
							<div className="text-white/50 text-xs bg-white/10 backdrop-blur-sm px-3 py-1.5 rounded-md">
								Scroll to zoom
							</div>
						</div>

						{/* Scrollable content area with actual sized image */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled separately */}
						{/* biome-ignore lint/a11y/noStaticElementInteractions: Click-to-close area */}
						<div
							className="relative z-[101] min-h-full min-w-full flex items-center justify-center p-16"
							style={{
								// Ensure container is at least as big as the zoomed image + padding
								minHeight: `max(100vh, calc(${displaySize.height} + 8rem))`,
								minWidth: `max(100vw, calc(${displaySize.width} + 8rem))`,
							}}
							onClick={(e) => {
								if (e.target === e.currentTarget) {
									handleClose();
								}
							}}
						>
							{/* biome-ignore lint/a11y/useAltText: Filename provides context */}
							{/* biome-ignore lint/performance/noImgElement: Data URLs work better with img */}
							<img
								src={src}
								style={{
									width: displaySize.width,
									height: displaySize.height,
								}}
								className="object-contain"
								title={filename}
								draggable={false}
								onLoad={handleImageLoad}
							/>
						</div>
					</div>,
					document.body,
				)
			: null;

	return (
		<>
			{/* Thumbnail */}
			<button
				type="button"
				onClick={() => setIsOpen(true)}
				className={cn(
					"group relative max-w-xs rounded-lg overflow-hidden border border-border cursor-pointer transition-all hover:border-primary/50 hover:shadow-md",
					className,
				)}
			>
				{/* biome-ignore lint/a11y/useAltText: Filename provides context */}
				{/* biome-ignore lint/performance/noImgElement: Data URLs work better with img */}
				<img src={src} className="max-w-full h-auto" title={filename} />
				{/* Hover overlay */}
				<div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
					<Maximize2 className="size-6 text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg" />
				</div>
			</button>

			{lightbox}
		</>
	);
}
