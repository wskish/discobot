"use client";

import {
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Key,
	Plus,
	Search,
	Trash2,
} from "lucide-react";
import * as React from "react";
import { IconRenderer } from "@/components/ide/icon-renderer";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
	Agent,
	AuthProvider,
	CreateAgentRequest,
	MCPServer,
	MCPServerConfig,
	SupportedAgentType,
} from "@/lib/api-types";
import { useAgentTypes } from "@/lib/hooks/use-agent-types";
import {
	getAuthProviderLogoUrl,
	useAuthProviders,
} from "@/lib/hooks/use-auth-providers";
import { useCredentials } from "@/lib/hooks/use-credentials";
import { cn } from "@/lib/utils";

function parseCommandLine(input: string): { command: string; args: string[] } {
	const tokens: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (char === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			continue;
		}

		if (char === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			continue;
		}

		if (char === " " && !inSingleQuote && !inDoubleQuote) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current) {
		tokens.push(current);
	}

	const [command = "", ...args] = tokens;
	return { command, args };
}

function ProviderLogo({
	providerId,
	className,
}: {
	providerId: string;
	className?: string;
}) {
	const [hasError, setHasError] = React.useState(false);
	const logoUrl = getAuthProviderLogoUrl(providerId);

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

interface AuthProviderRowProps {
	providerId: string;
	provider?: AuthProvider;
	isConfigured: boolean;
	onConfigure: () => void;
}

function AuthProviderRow({
	providerId,
	provider,
	isConfigured,
	onConfigure,
}: AuthProviderRowProps) {
	const displayName = provider?.name ?? providerId;

	return (
		<div className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg bg-muted/30 border">
			<div className="flex items-center gap-3 min-w-0">
				<div className="h-5 w-5 rounded flex items-center justify-center shrink-0 overflow-hidden bg-background">
					<ProviderLogo providerId={providerId} className="h-4 w-4" />
				</div>
				<div className="min-w-0">
					<div className="text-sm font-medium truncate">{displayName}</div>
				</div>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				{isConfigured ? (
					<div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-500">
						<CheckCircle2 className="h-3.5 w-3.5" />
						Configured
					</div>
				) : (
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={onConfigure}
					>
						Configure
					</Button>
				)}
			</div>
		</div>
	);
}

// Component to show auth providers with optional search
function AuthProvidersSection({
	selectedType,
	providers,
	providersMap,
	configuredProviderIds,
	onOpenCredentials,
}: {
	selectedType: SupportedAgentType | null;
	providers: AuthProvider[];
	providersMap: Record<string, AuthProvider>;
	configuredProviderIds: Set<string>;
	onOpenCredentials?: (providerId?: string) => void;
}) {
	const [search, setSearch] = React.useState("");

	// Reset search when selected type changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional - reset search when type changes
	React.useEffect(() => {
		setSearch("");
	}, [selectedType?.id]);

	if (
		!selectedType?.supportedAuthProviders ||
		selectedType.supportedAuthProviders.length === 0
	) {
		return null;
	}

	// Handle '*' wildcard - show all providers with env vars
	const isWildcard = selectedType.supportedAuthProviders.includes("*");
	const allProviderIds = isWildcard
		? providers.filter((p) => p.env && p.env.length > 0).map((p) => p.id)
		: selectedType.supportedAuthProviders;

	const showSearch = allProviderIds.length > 6;

	// Filter providers by search
	const filteredProviderIds =
		showSearch && search.trim()
			? allProviderIds.filter((id) => {
					const provider = providersMap[id];
					const query = search.toLowerCase();
					return (
						id.toLowerCase().includes(query) ||
						provider?.name?.toLowerCase().includes(query) ||
						provider?.env?.some((e) => e.toLowerCase().includes(query))
					);
				})
			: allProviderIds;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<Label>Authentication</Label>
				{onOpenCredentials && (
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs gap-1.5"
						onClick={() => {
							onOpenCredentials();
						}}
					>
						<Key className="h-3 w-3" />
						Manage All
					</Button>
				)}
			</div>

			{showSearch && (
				<div className="relative">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search providers..."
						className="pl-9 h-8"
					/>
				</div>
			)}

			<div className="space-y-2 max-h-[200px] overflow-y-auto">
				{filteredProviderIds.length === 0 ? (
					<div className="py-4 text-center text-sm text-muted-foreground">
						No providers found
					</div>
				) : (
					filteredProviderIds.map((providerId) => (
						<AuthProviderRow
							key={providerId}
							providerId={providerId}
							provider={providersMap[providerId]}
							isConfigured={configuredProviderIds.has(providerId)}
							onConfigure={() => {
								if (onOpenCredentials) {
									onOpenCredentials(providerId);
								}
							}}
						/>
					))
				)}
			</div>
			<p className="text-xs text-muted-foreground">
				Configure at least one provider to use this agent.
			</p>
		</div>
	);
}

interface AddAgentDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAdd: (agent: CreateAgentRequest) => Promise<void>;
	editingAgent?: Agent | null;
	onOpenCredentials?: (providerId?: string) => void;
	preselectedAgentTypeId?: string | null;
}

function MCPServerEditor({
	server,
	onChange,
	onRemove,
}: {
	server: MCPServer;
	onChange: (server: MCPServer) => void;
	onRemove: () => void;
}) {
	const [commandLine, setCommandLine] = React.useState(() => {
		if (server.config.type === "stdio") {
			const parts = [server.config.command, ...(server.config.args || [])];
			return parts.map((p) => (p.includes(" ") ? `"${p}"` : p)).join(" ");
		}
		return "";
	});

	const parsed = React.useMemo(
		() => parseCommandLine(commandLine),
		[commandLine],
	);

	const updateConfig = (updates: Partial<MCPServerConfig>) => {
		onChange({
			...server,
			config: { ...server.config, ...updates } as MCPServerConfig,
		});
	};

	const handleCommandLineChange = (value: string) => {
		setCommandLine(value);
		const { command, args } = parseCommandLine(value);
		updateConfig({
			command,
			args: args.length > 0 ? args : undefined,
		});
	};

	return (
		<div className="border rounded-lg p-3 space-y-3 bg-muted/30">
			<div className="flex items-center justify-between gap-2">
				<Input
					value={server.name}
					onChange={(e) => onChange({ ...server, name: e.target.value })}
					placeholder="Server name"
					className="flex-1 h-8"
				/>
				<Button
					variant="ghost"
					size="icon"
					className="h-8 w-8 shrink-0"
					onClick={onRemove}
				>
					<Trash2 className="h-4 w-4 text-destructive" />
				</Button>
			</div>

			<div className="flex gap-2">
				<Button
					variant={server.config.type === "stdio" ? "secondary" : "ghost"}
					size="sm"
					className="h-7 text-xs"
					onClick={() => {
						setCommandLine("");
						onChange({
							...server,
							config: { type: "stdio", command: "" },
						});
					}}
				>
					stdio
				</Button>
				<Button
					variant={server.config.type === "http" ? "secondary" : "ghost"}
					size="sm"
					className="h-7 text-xs"
					onClick={() =>
						onChange({
							...server,
							config: { type: "http", url: "" },
						})
					}
				>
					HTTP Streaming
				</Button>
			</div>

			{server.config.type === "stdio" ? (
				<div className="space-y-2">
					<div>
						<Label className="text-xs text-muted-foreground">Command</Label>
						<Input
							value={commandLine}
							onChange={(e) => handleCommandLineChange(e.target.value)}
							placeholder="npx -y @modelcontextprotocol/server-filesystem /path/to/dir"
							className="h-8 text-sm font-mono"
						/>
						{commandLine && (
							<div className="mt-1.5 text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1">
								<span className="text-foreground/70">command:</span>{" "}
								{parsed.command || <span className="italic">empty</span>}
								{parsed.args.length > 0 && (
									<>
										<br />
										<span className="text-foreground/70">args:</span> [
										{parsed.args.map((a, i) => (
											<span key={`${i}-${a}`}>
												{i > 0 && ", "}"{a}"
											</span>
										))}
										]
									</>
								)}
							</div>
						)}
					</div>
					<div>
						<Label className="text-xs text-muted-foreground">
							Environment Variables (KEY=value, one per line)
						</Label>
						<Textarea
							value={Object.entries(server.config.env || {})
								.map(([k, v]) => `${k}=${v}`)
								.join("\n")}
							onChange={(e) => {
								const env: Record<string, string> = {};
								e.target.value.split("\n").forEach((line) => {
									const [key, ...rest] = line.split("=");
									if (key && rest.length > 0) {
										env[key.trim()] = rest.join("=").trim();
									}
								});
								updateConfig({
									env: Object.keys(env).length > 0 ? env : undefined,
								});
							}}
							placeholder="API_KEY=xxx"
							className="min-h-[60px] text-sm font-mono resize-none"
						/>
					</div>
				</div>
			) : (
				<div className="space-y-2">
					<div>
						<Label className="text-xs text-muted-foreground">URL</Label>
						<Input
							value={server.config.url}
							onChange={(e) => updateConfig({ url: e.target.value })}
							placeholder="http://localhost:3001/mcp"
							className="h-8 text-sm font-mono"
						/>
					</div>
					<div>
						<Label className="text-xs text-muted-foreground">
							Headers (KEY: value, one per line)
						</Label>
						<Textarea
							value={Object.entries(server.config.headers || {})
								.map(([k, v]) => `${k}: ${v}`)
								.join("\n")}
							onChange={(e) => {
								const headers: Record<string, string> = {};
								e.target.value.split("\n").forEach((line) => {
									const [key, ...rest] = line.split(":");
									if (key && rest.length > 0) {
										headers[key.trim()] = rest.join(":").trim();
									}
								});
								updateConfig({
									headers:
										Object.keys(headers).length > 0 ? headers : undefined,
								});
							}}
							placeholder="Authorization: Bearer xxx"
							className="min-h-[60px] text-sm font-mono resize-none"
						/>
					</div>
				</div>
			)}
		</div>
	);
}

export function AddAgentDialog({
	open,
	onOpenChange,
	onAdd,
	editingAgent,
	onOpenCredentials,
	preselectedAgentTypeId,
}: AddAgentDialogProps) {
	const { agentTypes, isLoading } = useAgentTypes();
	const { credentials } = useCredentials();
	const { providers, providersMap } = useAuthProviders();
	const [selectedType, setSelectedType] =
		React.useState<SupportedAgentType | null>(null);
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [systemPrompt, setSystemPrompt] = React.useState("");
	const [mcpServers, setMcpServers] = React.useState<MCPServer[]>([]);
	const [isSubmitting, setIsSubmitting] = React.useState(false);
	const [advancedOpen, setAdvancedOpen] = React.useState(false);

	// Auto-select agent type when preselectedAgentTypeId is provided
	React.useEffect(() => {
		if (preselectedAgentTypeId && agentTypes.length > 0 && !selectedType) {
			const agentType = agentTypes.find((t) => t.id === preselectedAgentTypeId);
			if (agentType) {
				setSelectedType(agentType);
				setName(agentType.name);
				setDescription(agentType.description);
			}
		}
	}, [preselectedAgentTypeId, agentTypes, selectedType]);

	// Get configured provider IDs
	const configuredProviderIds = React.useMemo(
		() =>
			new Set(credentials.filter((c) => c.isConfigured).map((c) => c.provider)),
		[credentials],
	);

	// Check if at least one supported provider is configured
	const hasConfiguredProvider = React.useMemo(() => {
		if (!selectedType?.supportedAuthProviders?.length) return true; // No auth required

		const isWildcard = selectedType.supportedAuthProviders.includes("*");
		const supportedIds = isWildcard
			? providers.filter((p) => p.env && p.env.length > 0).map((p) => p.id)
			: selectedType.supportedAuthProviders;

		return supportedIds.some((id) => configuredProviderIds.has(id));
	}, [selectedType, providers, configuredProviderIds]);

	React.useEffect(() => {
		if (editingAgent && agentTypes.length > 0) {
			const type = agentTypes.find((t) => t.id === editingAgent.agentType);
			if (type) setSelectedType(type);

			// Only set name/description if they differ from the agent type defaults
			const hasCustomName = editingAgent.name !== type?.name;
			const hasCustomDescription =
				editingAgent.description !== type?.description;
			setName(hasCustomName ? editingAgent.name : "");
			setDescription(hasCustomDescription ? editingAgent.description : "");
			setSystemPrompt(editingAgent.systemPrompt || "");
			setMcpServers(editingAgent.mcpServers || []);

			if (
				hasCustomName ||
				hasCustomDescription ||
				editingAgent.systemPrompt ||
				(editingAgent.mcpServers && editingAgent.mcpServers.length > 0)
			) {
				setAdvancedOpen(true);
			}
		}
	}, [editingAgent, agentTypes]);

	const handleReset = () => {
		setSelectedType(null);
		setName("");
		setDescription("");
		setSystemPrompt("");
		setMcpServers([]);
		setAdvancedOpen(false);
	};

	const handleOpenChange = (newOpen: boolean) => {
		if (!newOpen) {
			handleReset();
		}
		onOpenChange(newOpen);
	};

	const handleAddMcpServer = () => {
		setMcpServers((prev) => [
			...prev,
			{
				id: `mcp-${Date.now()}`,
				name: "",
				config: { type: "stdio", command: "" },
				enabled: true,
			},
		]);
	};

	const handleUpdateMcpServer = (index: number, server: MCPServer) => {
		setMcpServers((prev) => prev.map((s, i) => (i === index ? server : s)));
	};

	const handleRemoveMcpServer = (index: number) => {
		setMcpServers((prev) => prev.filter((_, i) => i !== index));
	};

	const handleSubmit = async () => {
		if (!selectedType) return;

		setIsSubmitting(true);
		try {
			await onAdd({
				name: name.trim() || selectedType.name,
				description: description.trim() || selectedType.description,
				agentType: selectedType.id,
				systemPrompt: systemPrompt.trim() || undefined,
				mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
			});
			handleReset();
			onOpenChange(false);
		} finally {
			setIsSubmitting(false);
		}
	};

	const isEditing = !!editingAgent;
	const dialogTitle = isEditing ? "Configure Agent" : "Add Agent";
	const dialogDescription = isEditing
		? "Update this agent's configuration and capabilities."
		: "Create a new AI coding agent by selecting a type and configuring its capabilities.";
	const submitButtonText = isEditing
		? isSubmitting
			? "Saving..."
			: "Save Changes"
		: isSubmitting
			? "Creating..."
			: "Create Agent";

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-[550px] max-h-[85vh] overflow-hidden flex flex-col">
				<DialogHeader>
					<DialogTitle>{dialogTitle}</DialogTitle>
					<DialogDescription>{dialogDescription}</DialogDescription>
				</DialogHeader>

				<div className="flex-1 overflow-y-auto space-y-6 py-4 pr-2">
					<div className="space-y-2">
						<Label>Agent Type</Label>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									className="w-full justify-between bg-transparent"
									disabled={isLoading}
								>
									{selectedType ? (
										<div className="flex items-center gap-2">
											<IconRenderer
												icons={selectedType.icons}
												className="h-4 w-4"
											/>
											<span>{selectedType.name}</span>
										</div>
									) : (
										<span className="text-muted-foreground">
											{isLoading ? "Loading..." : "Select agent type"}
										</span>
									)}
									<ChevronDown className="h-4 w-4 opacity-50" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-[500px]" align="start">
								{agentTypes.map((type) => (
									<DropdownMenuItem
										key={type.id}
										onClick={() => setSelectedType(type)}
										className="flex items-start gap-3 py-3"
									>
										<span className="h-5 w-5 mt-0.5 shrink-0 flex items-center justify-center">
											<IconRenderer icons={type.icons} className="h-5 w-5" />
										</span>
										<div className="flex-1 min-w-0">
											<div className="font-medium">{type.name}</div>
											<div className="text-xs text-muted-foreground line-clamp-2">
												{type.description}
											</div>
										</div>
										{selectedType?.id === type.id && (
											<Check className="h-4 w-4 text-primary shrink-0" />
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>

					{/* Auth Providers Section */}
					<AuthProvidersSection
						selectedType={selectedType}
						providers={providers}
						providersMap={providersMap}
						configuredProviderIds={configuredProviderIds}
						onOpenCredentials={onOpenCredentials}
					/>

					<Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
						<CollapsibleTrigger asChild>
							<Button
								variant="ghost"
								className="w-full justify-start gap-2 px-0 hover:bg-transparent"
							>
								{advancedOpen ? (
									<ChevronDown className="h-4 w-4" />
								) : (
									<ChevronRight className="h-4 w-4" />
								)}
								<span className="font-medium">Advanced Configuration</span>
								{(name ||
									description ||
									systemPrompt ||
									mcpServers.length > 0) && (
									<span className="text-xs text-muted-foreground ml-auto">
										{[
											name && "custom name",
											description && "custom description",
											systemPrompt && "custom prompt",
											mcpServers.length > 0 &&
												`${mcpServers.length} server${mcpServers.length > 1 ? "s" : ""}`,
										]
											.filter(Boolean)
											.join(", ")}
									</span>
								)}
							</Button>
						</CollapsibleTrigger>
						<CollapsibleContent className="space-y-6 pt-4">
							<div className="space-y-2">
								<Label htmlFor="agent-name">Name</Label>
								<Input
									id="agent-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder={selectedType?.name || "My Agent"}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="agent-description">Description</Label>
								<Input
									id="agent-description"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									placeholder={
										selectedType?.description || "A helpful coding assistant"
									}
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="system-prompt">Additional System Prompt</Label>
								<Textarea
									id="system-prompt"
									value={systemPrompt}
									onChange={(e) => setSystemPrompt(e.target.value)}
									placeholder="Add custom instructions for this agent..."
									className="min-h-[100px] resize-none"
								/>
								<p className="text-xs text-muted-foreground">
									This will be appended to the agent&apos;s default system
									prompt.
								</p>
							</div>

							<div className="space-y-3">
								<div className="flex items-center justify-between">
									<Label>MCP Servers</Label>
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs gap-1 bg-transparent"
										onClick={handleAddMcpServer}
									>
										<Plus className="h-3 w-3" />
										Add Server
									</Button>
								</div>
								{mcpServers.length === 0 ? (
									<p className="text-sm text-muted-foreground py-4 text-center border rounded-lg border-dashed">
										No custom MCP servers configured
									</p>
								) : (
									<div className="space-y-3">
										{mcpServers.map((server, index) => (
											<MCPServerEditor
												key={server.id}
												server={server}
												onChange={(s) => handleUpdateMcpServer(index, s)}
												onRemove={() => handleRemoveMcpServer(index)}
											/>
										))}
									</div>
								)}
							</div>
						</CollapsibleContent>
					</Collapsible>
				</div>

				<DialogFooter className="border-t pt-4">
					<Button variant="outline" onClick={() => handleOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={handleSubmit}
						disabled={!selectedType || !hasConfiguredProvider || isSubmitting}
						title={
							!hasConfiguredProvider
								? "Configure at least one auth provider"
								: undefined
						}
					>
						{submitButtonText}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
