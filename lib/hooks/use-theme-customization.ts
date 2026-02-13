import { useTheme } from "next-themes";
import { useCallback, useEffect, useState } from "react";
import type { ThemeColorScheme } from "@/lib/api-types";
import { THEMES } from "@/lib/theme-constants";
import { usePreferences } from "./use-preferences";

export function useThemeCustomization() {
	const { theme, setTheme, resolvedTheme } = useTheme();
	const { getPreference, setPreference } = usePreferences();
	const [colorScheme, setColorSchemeState] =
		useState<ThemeColorScheme>("default");
	const [mounted, setMounted] = useState(false);

	const applyThemeAttribute = useCallback((scheme: ThemeColorScheme) => {
		if (typeof document !== "undefined") {
			document.documentElement.setAttribute("data-theme", scheme);
		}
	}, []);

	// Load from preferences on mount
	useEffect(() => {
		setMounted(true);
		const saved = getPreference("theme.colorScheme") as
			| ThemeColorScheme
			| undefined;
		if (saved) {
			setColorSchemeState(saved);
			applyThemeAttribute(saved);
		} else {
			// Apply default theme
			applyThemeAttribute("default");
		}
	}, [getPreference, applyThemeAttribute]);

	const setColorScheme = (scheme: ThemeColorScheme) => {
		setColorSchemeState(scheme);
		applyThemeAttribute(scheme);
		setPreference("theme.colorScheme", scheme);
	};

	// Filter themes based on current light/dark mode
	const availableThemes = THEMES.filter((t) => t.mode === resolvedTheme);

	return {
		theme,
		setTheme,
		resolvedTheme,
		colorScheme,
		setColorScheme,
		availableThemes,
		mounted,
	};
}
