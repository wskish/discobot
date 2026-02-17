import { Info, Key, Settings } from "lucide-react";
import * as React from "react";
import {
	createModelVariants,
	deduplicateModels,
	sortModelVariants,
} from "@/components/ide/model-selector";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useDialogContext } from "@/lib/contexts/dialog-context";
import { useMainContentContext } from "@/lib/contexts/main-content-context";
import { useAgents } from "@/lib/hooks/use-agents";
import { useAgentModels } from "@/lib/hooks/use-models";
import { PREFERENCE_KEYS, usePreferences } from "@/lib/hooks/use-preferences";
import { useThemeCustomization } from "@/lib/hooks/use-theme-customization";

interface SettingsMenuProps {
	className?: string;
}

export function SettingsMenu({ className }: SettingsMenuProps) {
	const dialogs = useDialogContext();
	const { chatWidthMode, setChatWidthMode } = useMainContentContext();

	// Theme customization
	const {
		theme,
		setTheme,
		colorScheme,
		setColorScheme,
		availableThemes,
		mounted: themeMounted,
	} = useThemeCustomization();

	// User preferences
	const { getPreference, setPreference } = usePreferences();
	const defaultModelPref = getPreference(PREFERENCE_KEYS.DEFAULT_MODEL);

	// Get default agent to fetch its models
	const { agents } = useAgents();
	const defaultAgent = React.useMemo(
		() => agents.find((a) => a.isDefault) || agents[0],
		[agents],
	);

	// Fetch models for the default agent
	const { models: rawModels } = useAgentModels(defaultAgent?.id || null);

	// Process models (deduplicate and create variants)
	const modelVariants = React.useMemo(() => {
		const deduplicated = deduplicateModels(rawModels);
		const variants = createModelVariants(deduplicated);
		return sortModelVariants(variants);
	}, [rawModels]);

	// Handle default model change
	const handleDefaultModelChange = React.useCallback(
		async (value: string) => {
			if (value === "none") {
				// Clear the preference
				await setPreference(PREFERENCE_KEYS.DEFAULT_MODEL, "");
			} else {
				await setPreference(PREFERENCE_KEYS.DEFAULT_MODEL, value);
			}
		},
		[setPreference],
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					title="Settings"
					className={className}
				>
					<Settings className="h-4 w-4" />
					<span className="sr-only">Settings</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="w-80 max-h-[80vh] overflow-y-auto"
				sideOffset={5}
			>
				{themeMounted && (
					<>
						<DropdownMenuLabel>Appearance</DropdownMenuLabel>
						<div className="px-2 py-2 space-y-4">
							{/* Mode selector */}
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">Mode</Label>
								<RadioGroup
									value={theme}
									onValueChange={setTheme}
									className="flex gap-2"
								>
									<div className="flex-1">
										<RadioGroupItem
											value="light"
											id="mode-light"
											className="peer sr-only"
										/>
										<Label
											htmlFor="mode-light"
											className="flex items-center justify-center rounded-md border-2 border-muted bg-transparent px-3 py-2 text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-accent"
										>
											Light
										</Label>
									</div>
									<div className="flex-1">
										<RadioGroupItem
											value="dark"
											id="mode-dark"
											className="peer sr-only"
										/>
										<Label
											htmlFor="mode-dark"
											className="flex items-center justify-center rounded-md border-2 border-muted bg-transparent px-3 py-2 text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-accent"
										>
											Dark
										</Label>
									</div>
									<div className="flex-1">
										<RadioGroupItem
											value="system"
											id="mode-system"
											className="peer sr-only"
										/>
										<Label
											htmlFor="mode-system"
											className="flex items-center justify-center rounded-md border-2 border-muted bg-transparent px-3 py-2 text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-accent"
										>
											System
										</Label>
									</div>
								</RadioGroup>
							</div>

							{/* Theme selector */}
							<div className="space-y-2">
								<Label className="text-xs text-muted-foreground">Theme</Label>
								<Select value={colorScheme} onValueChange={setColorScheme}>
									<SelectTrigger className="w-full">
										<SelectValue>
											{availableThemes.find((t) => t.id === colorScheme) && (
												<div className="flex items-center gap-2">
													<div className="flex gap-1">
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: availableThemes.find(
																	(t) => t.id === colorScheme,
																)?.preview.background,
															}}
														/>
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: availableThemes.find(
																	(t) => t.id === colorScheme,
																)?.preview.primary,
															}}
														/>
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: availableThemes.find(
																	(t) => t.id === colorScheme,
																)?.preview.foreground,
															}}
														/>
													</div>
													<span>
														{
															availableThemes.find((t) => t.id === colorScheme)
																?.name
														}
													</span>
												</div>
											)}
										</SelectValue>
									</SelectTrigger>
									<SelectContent>
										{availableThemes.map((themeOption) => (
											<SelectItem key={themeOption.id} value={themeOption.id}>
												<div className="flex items-center gap-2">
													<div className="flex gap-1">
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: themeOption.preview.background,
															}}
														/>
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: themeOption.preview.primary,
															}}
														/>
														<div
															className="w-3 h-3 rounded border border-border"
															style={{
																background: themeOption.preview.foreground,
															}}
														/>
													</div>
													<span>{themeOption.name}</span>
												</div>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<DropdownMenuSeparator />
					</>
				)}

				<DropdownMenuLabel>Chat</DropdownMenuLabel>
				<div className="px-2 py-2 space-y-4">
					{/* Default model selector */}
					<div className="space-y-2">
						<Label className="text-xs text-muted-foreground">
							Default model
						</Label>
						<Select
							value={defaultModelPref || "none"}
							onValueChange={handleDefaultModelChange}
						>
							<SelectTrigger className="w-full">
								<SelectValue placeholder="Auto-select">
									{defaultModelPref
										? modelVariants.find((v) => v.id === defaultModelPref)
												?.displayName || defaultModelPref
										: "Auto-select"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent className="max-h-[300px] z-[70]">
								<SelectItem value="none">Auto-select</SelectItem>
								{modelVariants.length > 0 && (
									<div className="px-2 py-1.5">
										<div className="h-px bg-border" />
									</div>
								)}
								{modelVariants.map((variant) => (
									<SelectItem key={variant.id} value={variant.id}>
										{variant.displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{/* Full width toggle */}
					<div className="flex items-center justify-between">
						<Label
							htmlFor="chat-full-width-toggle"
							className="text-sm font-normal cursor-pointer"
						>
							Full width
						</Label>
						<Switch
							id="chat-full-width-toggle"
							checked={chatWidthMode === "full"}
							onCheckedChange={(checked) =>
								setChatWidthMode(checked ? "full" : "constrained")
							}
						/>
					</div>
				</div>

				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => dialogs.credentialsDialog.open()}>
					<Key className="h-4 w-4 mr-2" />
					API Credentials
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => dialogs.supportInfoDialog.open()}>
					<Info className="h-4 w-4 mr-2" />
					Support Information
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
