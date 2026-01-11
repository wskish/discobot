"use client";

import {
	Eye,
	EyeOff,
	Key,
	Loader2,
	LogIn,
	Plus,
	Search,
	Trash2,
} from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CredentialAuthType, CredentialInfo } from "@/lib/api-types";
import { matchesProviderAlias } from "@/lib/config/provider-aliases";
import { useCredentials } from "@/lib/hooks/use-credentials";
import {
	getProviderLogoUrl,
	type ModelProvider,
	useModelsProviders,
} from "@/lib/hooks/use-models-providers";
import {
	getAuthTypesForProvider,
	getOAuthFlowComponent,
} from "@/lib/plugins/auth";
import { cn } from "@/lib/utils";

function ProviderLogo({
	providerId,
	className,
}: {
	providerId: string;
	className?: string;
}) {
	const [hasError, setHasError] = React.useState(false);
	const logoUrl = getProviderLogoUrl(providerId);

	if (hasError) {
		return <Key className={className} />;
	}

	return (
		<img
			src={logoUrl}
			alt=""
			className={cn("object-contain dark:invert", className)}
			onError={() => setHasError(true)}
		/>
	);
}

// Searchable provider combobox
function ProviderCombobox({
	providers,
	onSelect,
	onCancel,
}: {
	providers: ModelProvider[];
	onSelect: (provider: ModelProvider) => void;
	onCancel: () => void;
}) {
	const [search, setSearch] = React.useState("");
	const [highlightedIndex, setHighlightedIndex] = React.useState(0);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const listRef = React.useRef<HTMLDivElement>(null);

	const filteredProviders = React.useMemo(() => {
		if (!search.trim()) return providers;
		const query = search.toLowerCase();
		return providers.filter(
			(p) =>
				p.name.toLowerCase().includes(query) ||
				p.id.toLowerCase().includes(query) ||
				p.env?.some((e) => e.toLowerCase().includes(query)) ||
				matchesProviderAlias(p.id, query),
		);
	}, [providers, search]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional - reset index when list changes
	React.useEffect(() => {
		setHighlightedIndex(0);
	}, [filteredProviders.length]);

	React.useEffect(() => {
		inputRef.current?.focus();
	}, []);

	React.useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[highlightedIndex] as HTMLElement;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [highlightedIndex]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setHighlightedIndex((i) =>
					Math.min(i + 1, filteredProviders.length - 1),
				);
				break;
			case "ArrowUp":
				e.preventDefault();
				setHighlightedIndex((i) => Math.max(i - 1, 0));
				break;
			case "Enter":
				e.preventDefault();
				if (filteredProviders[highlightedIndex]) {
					onSelect(filteredProviders[highlightedIndex]);
				}
				break;
			case "Escape":
				e.preventDefault();
				onCancel();
				break;
		}
	};

	return (
		<div className="space-y-2">
			<div className="relative">
				<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
				<Input
					ref={inputRef}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder="Search providers..."
					className="pl-9"
				/>
			</div>
			<div
				ref={listRef}
				className="max-h-[250px] overflow-y-auto border rounded-md"
			>
				{filteredProviders.length === 0 ? (
					<div className="py-6 text-center text-sm text-muted-foreground">
						No providers found
					</div>
				) : (
					filteredProviders.map((provider, index) => (
						<button
							key={provider.id}
							type="button"
							className={cn(
								"w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 transition-colors",
								index === highlightedIndex && "bg-muted",
							)}
							onClick={() => onSelect(provider)}
							onMouseEnter={() => setHighlightedIndex(index)}
						>
							<div className="h-5 w-5 rounded flex items-center justify-center shrink-0 overflow-hidden">
								<ProviderLogo providerId={provider.id} className="h-4 w-4" />
							</div>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium">{provider.name}</div>
								{provider.env?.[0] && (
									<div className="text-xs text-muted-foreground font-mono truncate">
										{provider.env[0]}
									</div>
								)}
							</div>
						</button>
					))
				)}
			</div>
			<div className="flex justify-end">
				<Button variant="ghost" size="sm" onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

// Compact row for configured credentials
function ConfiguredCredentialRow({
	credential,
	provider,
	onEdit,
	onRemove,
}: {
	credential: CredentialInfo;
	provider?: ModelProvider;
	onEdit: () => void;
	onRemove: () => void;
}) {
	const authTypes = getAuthTypesForProvider(credential.provider);
	const authLabel =
		authTypes.find((a) => a.type === credential.authType)?.label ?? "API Key";

	return (
		<div className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg bg-muted/30 border">
			<div className="flex items-center gap-3 min-w-0">
				<div className="h-6 w-6 rounded flex items-center justify-center shrink-0 overflow-hidden bg-background">
					<ProviderLogo providerId={credential.provider} className="h-4 w-4" />
				</div>
				<div className="min-w-0">
					<div className="font-medium text-sm truncate">
						{provider?.name ?? credential.name}
					</div>
					<div className="text-xs text-muted-foreground">{authLabel}</div>
				</div>
			</div>
			<div className="flex items-center gap-1 shrink-0">
				<Button variant="ghost" size="sm" className="h-7 px-2" onClick={onEdit}>
					Edit
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					onClick={onRemove}
				>
					<Trash2 className="h-3.5 w-3.5 text-destructive" />
				</Button>
			</div>
		</div>
	);
}

// Form for adding/editing a credential
function CredentialForm({
	provider,
	existingCredential,
	onSave,
	onCancel,
}: {
	provider: ModelProvider;
	existingCredential?: CredentialInfo;
	onSave: (
		authType: CredentialAuthType,
		data: { apiKey?: string },
	) => Promise<void>;
	onCancel: () => void;
}) {
	const authTypes = getAuthTypesForProvider(provider.id);
	const [selectedAuthType, setSelectedAuthType] =
		React.useState<CredentialAuthType>(
			existingCredential?.authType ?? authTypes[0].type,
		);
	const [apiKey, setApiKey] = React.useState("");
	const [showSecret, setShowSecret] = React.useState(false);
	const [isSubmitting, setIsSubmitting] = React.useState(false);
	const inputRef = React.useRef<HTMLInputElement>(null);

	const hasMultipleAuthTypes = authTypes.length > 1;
	const isEditing = !!existingCredential;

	// Get OAuth flow component from plugin system
	const OAuthFlowComponent =
		selectedAuthType === "oauth"
			? getOAuthFlowComponent(provider.id)
			: undefined;

	React.useEffect(() => {
		if (selectedAuthType === "api_key" && inputRef.current) {
			inputRef.current.focus();
		}
	}, [selectedAuthType]);

	const handleSave = async () => {
		if (!apiKey.trim()) return;
		setIsSubmitting(true);
		try {
			await onSave("api_key", { apiKey: apiKey.trim() });
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			onCancel();
		}
		if (e.key === "Enter" && selectedAuthType === "api_key") {
			handleSave();
		}
	};

	const primaryEnvVar = provider.env?.[0];

	// Show OAuth flow from plugin if available
	if (OAuthFlowComponent) {
		return (
			<OAuthFlowComponent
				onComplete={onCancel}
				onCancel={() => setSelectedAuthType("api_key")}
			/>
		);
	}

	return (
		<div className="space-y-4">
			{/* Provider header */}
			<div className="flex items-center gap-3 pb-3 border-b">
				<div className="h-8 w-8 rounded-md flex items-center justify-center bg-muted overflow-hidden">
					<ProviderLogo providerId={provider.id} className="h-5 w-5" />
				</div>
				<div>
					<div className="font-medium">{provider.name}</div>
					{primaryEnvVar && (
						<div className="text-xs text-muted-foreground font-mono">
							{primaryEnvVar}
						</div>
					)}
				</div>
			</div>

			{/* Auth type selector */}
			{hasMultipleAuthTypes && (
				<div className="flex gap-2">
					{authTypes.map((authOption) => (
						<Button
							key={authOption.type}
							variant={
								selectedAuthType === authOption.type ? "secondary" : "ghost"
							}
							size="sm"
							className="h-8"
							onClick={() => {
								setSelectedAuthType(authOption.type);
								setApiKey("");
							}}
						>
							{authOption.type === "oauth" ? (
								<LogIn className="h-3.5 w-3.5 mr-1.5" />
							) : (
								<Key className="h-3.5 w-3.5 mr-1.5" />
							)}
							{authOption.label}
						</Button>
					))}
				</div>
			)}

			{/* API Key input */}
			{selectedAuthType === "api_key" && (
				<div className="space-y-2">
					<Label className="text-sm">API Key</Label>
					<div className="relative">
						<Input
							ref={inputRef}
							type={showSecret ? "text" : "password"}
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={isEditing ? "Enter new key to update" : "sk-..."}
							className="pr-10 font-mono text-sm"
							disabled={isSubmitting}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="absolute right-0 top-0 h-full w-9"
							onClick={() => setShowSecret(!showSecret)}
						>
							{showSecret ? (
								<EyeOff className="h-4 w-4" />
							) : (
								<Eye className="h-4 w-4" />
							)}
						</Button>
					</div>
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-2 pt-2">
				<Button variant="outline" size="sm" onClick={onCancel}>
					Cancel
				</Button>
				<Button
					size="sm"
					onClick={handleSave}
					disabled={!apiKey.trim() || isSubmitting}
				>
					{isSubmitting ? (
						<>
							<Loader2 className="h-4 w-4 mr-2 animate-spin" />
							Saving...
						</>
					) : isEditing ? (
						"Update"
					) : (
						"Save"
					)}
				</Button>
			</div>
		</div>
	);
}

interface CredentialsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** If provided, opens directly to the form for this provider */
	initialProviderId?: string | null;
}

type DialogView = "list" | "search" | "form";

export function CredentialsDialog({
	open,
	onOpenChange,
	initialProviderId,
}: CredentialsDialogProps) {
	const {
		providers,
		providersMap,
		isLoading: providersLoading,
	} = useModelsProviders();
	const {
		credentials,
		isLoading: credentialsLoading,
		createCredential,
		deleteCredential,
	} = useCredentials();

	const [view, setView] = React.useState<DialogView>("list");
	const [editingProvider, setEditingProvider] =
		React.useState<ModelProvider | null>(null);
	// Track if we opened with an initial provider (to auto-close on save/cancel)
	const [openedWithInitialProvider, setOpenedWithInitialProvider] =
		React.useState(false);

	// Handle initial provider selection when dialog opens
	React.useEffect(() => {
		if (open && initialProviderId && !providersLoading) {
			const provider = providersMap[initialProviderId];
			if (provider) {
				setEditingProvider(provider);
				setView("form");
				setOpenedWithInitialProvider(true);
			}
		}
	}, [open, initialProviderId, providersMap, providersLoading]);

	// Reset state when dialog closes
	React.useEffect(() => {
		if (!open) {
			setView("list");
			setEditingProvider(null);
			setOpenedWithInitialProvider(false);
		}
	}, [open]);

	const handleSave = async (
		providerId: string,
		authType: CredentialAuthType,
		data: { apiKey?: string },
	) => {
		await createCredential({
			provider: providerId,
			authType,
			apiKey: data.apiKey,
		});
		if (openedWithInitialProvider) {
			onOpenChange(false);
		} else {
			setView("list");
			setEditingProvider(null);
		}
	};

	const handleFormCancel = () => {
		if (openedWithInitialProvider) {
			onOpenChange(false);
		} else {
			setView("list");
			setEditingProvider(null);
		}
	};

	const handleRemove = async (providerId: string) => {
		await deleteCredential(providerId);
	};

	const configuredCredentials = credentials.filter((c) => c.isConfigured);

	// Filter to providers with env vars that aren't already configured
	const configuredProviderIds = new Set(credentials.map((c) => c.provider));
	const availableProviders = providers.filter(
		(p) => p.env && p.env.length > 0 && !configuredProviderIds.has(p.id),
	);

	const isLoading = providersLoading || credentialsLoading;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[450px]">
				<DialogHeader>
					<DialogTitle>API Credentials</DialogTitle>
					<DialogDescription>
						Manage API keys for model providers.
					</DialogDescription>
				</DialogHeader>

				{view === "form" && editingProvider ? (
					<CredentialForm
						provider={editingProvider}
						existingCredential={credentials.find(
							(c) => c.provider === editingProvider.id,
						)}
						onSave={(authType, data) =>
							handleSave(editingProvider.id, authType, data)
						}
						onCancel={handleFormCancel}
					/>
				) : view === "search" ? (
					<ProviderCombobox
						providers={availableProviders}
						onSelect={(provider) => {
							setEditingProvider(provider);
							setView("form");
						}}
						onCancel={() => setView("list")}
					/>
				) : (
					<div className="space-y-4">
						{/* Configured credentials list */}
						{configuredCredentials.length > 0 && (
							<div className="space-y-2">
								{configuredCredentials.map((credential) => (
									<ConfiguredCredentialRow
										key={credential.id}
										credential={credential}
										provider={providersMap[credential.provider]}
										onEdit={() => {
											const provider = providersMap[credential.provider];
											if (provider) {
												setEditingProvider(provider);
												setView("form");
											}
										}}
										onRemove={() => handleRemove(credential.provider)}
									/>
								))}
							</div>
						)}

						{/* Empty state */}
						{!isLoading && configuredCredentials.length === 0 && (
							<div className="text-center py-6 text-muted-foreground text-sm">
								No credentials configured yet.
							</div>
						)}

						{/* Loading state */}
						{isLoading && (
							<div className="text-center py-6 text-muted-foreground text-sm">
								Loading...
							</div>
						)}

						{/* Add provider button */}
						<Button
							variant="outline"
							className="w-full justify-start gap-2"
							disabled={isLoading || availableProviders.length === 0}
							onClick={() => setView("search")}
						>
							<Plus className="h-4 w-4" />
							Add Provider
						</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
