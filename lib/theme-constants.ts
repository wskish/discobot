import type { ThemeColorScheme } from "./api-types";

export interface ThemeMetadata {
	id: ThemeColorScheme;
	name: string;
	mode: "light" | "dark";
	preview: {
		background: string;
		primary: string;
		foreground: string;
	};
}

export const THEMES: ThemeMetadata[] = [
	// Light themes
	{
		id: "default",
		name: "Default",
		mode: "light",
		preview: {
			background: "#fafafa",
			primary: "#3b82f6",
			foreground: "#262626",
		},
	},
	{
		id: "solarized",
		name: "Solarized",
		mode: "light",
		preview: {
			background: "#fdf6e3",
			primary: "#268bd2",
			foreground: "#657b83",
		},
	},
	{
		id: "alucard",
		name: "Alucard",
		mode: "light",
		preview: {
			background: "#fffbeb",
			primary: "#644ac9",
			foreground: "#1f1f1f",
		},
	},
	{
		id: "catppuccin-latte",
		name: "Catppuccin Latte",
		mode: "light",
		preview: {
			background: "#eff1f5",
			primary: "#1e66f5",
			foreground: "#4c4f69",
		},
	},
	// Dark themes
	{
		id: "default",
		name: "Default",
		mode: "dark",
		preview: {
			background: "#1e1e1e",
			primary: "#3b82f6",
			foreground: "#ededed",
		},
	},
	{
		id: "nord",
		name: "Nord",
		mode: "dark",
		preview: {
			background: "#2e3440",
			primary: "#88c0d0",
			foreground: "#d8dee9",
		},
	},
	{
		id: "tokyo-night",
		name: "Tokyo Night",
		mode: "dark",
		preview: {
			background: "#1a1b26",
			primary: "#7aa2f7",
			foreground: "#a9b1d6",
		},
	},
	{
		id: "dracula",
		name: "Dracula",
		mode: "dark",
		preview: {
			background: "#282a36",
			primary: "#bd93f9",
			foreground: "#f8f8f2",
		},
	},
	{
		id: "catppuccin-mocha",
		name: "Catppuccin Mocha",
		mode: "dark",
		preview: {
			background: "#1e1e2e",
			primary: "#89b4fa",
			foreground: "#cdd6f4",
		},
	},
	{
		id: "catppuccin-macchiato",
		name: "Catppuccin Macchiato",
		mode: "dark",
		preview: {
			background: "#24273a",
			primary: "#8aadf4",
			foreground: "#cad3f5",
		},
	},
	{
		id: "catppuccin-frappe",
		name: "Catppuccin Frappé",
		mode: "dark",
		preview: {
			background: "#303446",
			primary: "#8caaee",
			foreground: "#c6d0f5",
		},
	},
];
