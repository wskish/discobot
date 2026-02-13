import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useThemeCustomization } from "@/lib/hooks/use-theme-customization";

export function ThemeSelector({ className }: { className?: string }) {
	const { colorScheme, setColorScheme, availableThemes, mounted } =
		useThemeCustomization();

	// Prevent hydration mismatch
	if (!mounted) {
		return (
			<Button variant="ghost" size="icon" className={className}>
				<Palette className="h-4 w-4" />
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" className={className}>
					<Palette className="h-4 w-4" />
					<span className="sr-only">Select theme</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup
					value={colorScheme}
					onValueChange={(value) => setColorScheme(value as typeof colorScheme)}
				>
					{availableThemes.map((theme) => (
						<DropdownMenuRadioItem
							key={`${theme.mode}-${theme.id}`}
							value={theme.id}
						>
							<ThemePreview colors={theme.preview} />
							{theme.name}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ThemePreview({
	colors,
}: {
	colors: { background: string; primary: string; foreground: string };
}) {
	return (
		<div className="flex gap-1 mr-2">
			<div
				className="w-3 h-3 rounded-sm border border-border"
				style={{ background: colors.background }}
			/>
			<div
				className="w-3 h-3 rounded-sm border border-border"
				style={{ background: colors.primary }}
			/>
			<div
				className="w-3 h-3 rounded-sm border border-border"
				style={{ background: colors.foreground }}
			/>
		</div>
	);
}
