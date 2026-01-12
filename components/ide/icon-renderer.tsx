"use client";

import { Bot } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";
import type { Icon } from "@/lib/api-types";

interface IconRendererProps {
	icons?: Icon[];
	className?: string;
	fallback?: React.ReactNode;
	size?: number;
}

export function IconRenderer({
	icons,
	className,
	fallback,
	size,
}: IconRendererProps) {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = React.useState(false);

	// Avoid hydration mismatch
	React.useEffect(() => {
		setMounted(true);
	}, []);

	const sizeStyle = size
		? { width: `${size}px`, height: `${size}px` }
		: { width: "1em", height: "1em" };

	const currentTheme = mounted ? resolvedTheme : "light";
	const isDark = currentTheme === "dark";

	const icon = React.useMemo(() => {
		if (!icons || icons.length === 0) return null;

		// Filter icons by current theme or no theme specified (universal)
		const themeFilteredIcons = icons.filter(
			(i) => !i.theme || i.theme === currentTheme,
		);

		// If no icons match the theme, fall back to all icons
		const availableIcons =
			themeFilteredIcons.length > 0 ? themeFilteredIcons : icons;

		// Prefer SVG icons as they scale well
		const svgIcon = availableIcons.find((i) => i.mimeType === "image/svg+xml");
		if (svgIcon) return svgIcon;

		// Fall back to first available icon
		return availableIcons[0];
	}, [icons, currentTheme]);

	// Apply invert filter for icons that need color inversion in dark mode
	const shouldInvert = isDark && icon?.invertDark;
	const invertStyle = shouldInvert ? { filter: "invert(1)" } : {};

	if (!icon) {
		return fallback ? fallback : <Bot className={className} />;
	}

	if (
		icon.mimeType === "image/svg+xml" &&
		icon.src.startsWith("data:image/svg+xml,")
	) {
		try {
			// Decode the SVG from the data URI
			const svgContent = decodeURIComponent(
				icon.src.replace("data:image/svg+xml,", ""),
			);
			return (
				<span
					className={className}
					style={{ display: "inline-flex", ...sizeStyle, ...invertStyle }}
					// biome-ignore lint/security/noDangerouslySetInnerHtml: SVG content is decoded from data URI icons, not user input
					dangerouslySetInnerHTML={{
						__html: svgContent.replace(
							/<svg/,
							'<svg style="width:100%;height:100%"',
						),
					}}
				/>
			);
		} catch {
			// Fall back to img if decoding fails
		}
	}

	// For base64 SVGs or other image types, use img tag
	return (
		// biome-ignore lint/performance/noImgElement: Dynamic base64 icons cannot use Next.js Image optimization
		<img
			src={icon.src || "/placeholder.svg"}
			alt=""
			className={className}
			style={{ ...sizeStyle, objectFit: "contain", ...invertStyle }}
		/>
	);
}
