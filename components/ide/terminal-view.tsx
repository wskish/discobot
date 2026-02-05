import "@xterm/xterm/css/xterm.css";

import { Check, Copy, MessageSquare } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { getWsBase } from "@/lib/api-config";
import { cn } from "@/lib/utils";

/**
 * Get the SSH host from the current location.
 */
function getSSHHost(): string {
	if (typeof window === "undefined") return "localhost";
	const hostname = window.location.hostname;
	if (hostname === "127.0.0.1" || hostname === "::1") return "localhost";
	return hostname;
}

export type ConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

export interface TerminalViewHandle {
	reconnect: () => void;
}

interface TerminalViewProps {
	sessionId: string | null;
	root?: boolean;
	className?: string;
	onToggleChat?: () => void;
	hideHeader?: boolean;
	onConnectionStatusChange?: (status: ConnectionStatus) => void;
}

export const TerminalView = React.forwardRef<
	TerminalViewHandle,
	TerminalViewProps
>(function TerminalView(
	{
		sessionId,
		root = false,
		className,
		onToggleChat,
		hideHeader,
		onConnectionStatusChange,
	},
	ref,
) {
	const terminalRef = React.useRef<HTMLDivElement>(null);
	const xtermRef = React.useRef<import("@xterm/xterm").Terminal | null>(null);
	const fitAddonRef = React.useRef<import("@xterm/addon-fit").FitAddon | null>(
		null,
	);
	const wsRef = React.useRef<WebSocket | null>(null);
	const [connectionStatus, setConnectionStatus] =
		React.useState<ConnectionStatus>("disconnected");
	const [terminalReady, setTerminalReady] = React.useState(false);
	const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
	const lastSizeRef = React.useRef<{ rows: number; cols: number } | null>(null);
	// Track previous values to detect changes
	const prevSessionIdRef = React.useRef<string | null>(null);
	const prevRootRef = React.useRef<boolean>(false);
	const [copied, setCopied] = React.useState(false);

	// Update connection status and notify parent
	const updateConnectionStatus = React.useCallback(
		(status: ConnectionStatus) => {
			setConnectionStatus(status);
			onConnectionStatusChange?.(status);
		},
		[onConnectionStatusChange],
	);

	// Connect to WebSocket
	const connect = React.useCallback(
		(term: import("@xterm/xterm").Terminal) => {
			if (!sessionId) {
				term.writeln(
					"\x1b[33mNo session selected. Select a session to connect to the terminal.\x1b[0m",
				);
				return;
			}

			// Close any existing connection
			if (wsRef.current) {
				wsRef.current.close();
				wsRef.current = null;
			}

			// Clear any pending reconnect
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
				reconnectTimeoutRef.current = null;
			}

			updateConnectionStatus("connecting");
			term.writeln("\x1b[90mConnecting to terminal...\x1b[0m");

			const rows = term.rows;
			const cols = term.cols;
			const rootParam = root ? "&root=true" : "";
			const wsUrl = `${getWsBase()}/sessions/${sessionId}/terminal/ws?rows=${rows}&cols=${cols}${rootParam}`;

			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;

			ws.onopen = () => {
				updateConnectionStatus("connected");
				// Clear the terminal and let the shell provide its own prompt
				term.clear();
			};

			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data);
					if (msg.type === "output") {
						term.write(msg.data);
					} else if (msg.type === "error") {
						term.writeln(`\x1b[31mError: ${msg.data}\x1b[0m`);
					}
				} catch {
					// If not JSON, treat as raw output (shouldn't happen)
					term.write(event.data);
				}
			};

			ws.onerror = () => {
				updateConnectionStatus("error");
			};

			ws.onclose = (event) => {
				// Only handle close if this is still the current connection
				// If we've already started a new connection, ignore this close event
				if (wsRef.current !== ws) {
					return;
				}

				wsRef.current = null;

				if (event.wasClean) {
					updateConnectionStatus("disconnected");
					term.writeln("\x1b[90mTerminal disconnected.\x1b[0m");
				} else {
					updateConnectionStatus("error");
					term.writeln(
						`\x1b[31mConnection lost. Use reconnect button to retry.\x1b[0m`,
					);
				}
			};
		},
		[sessionId, root, updateConnectionStatus],
	);

	// Expose reconnect method via ref
	React.useImperativeHandle(
		ref,
		() => ({
			reconnect: () => {
				if (xtermRef.current) {
					xtermRef.current.clear();
					connect(xtermRef.current);
				}
			},
		}),
		[connect],
	);

	// Send input to WebSocket
	const sendInput = React.useCallback((data: string) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: "input", data }));
		}
	}, []);

	// Send resize event to WebSocket (debounced)
	const resizeTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
	const sendResize = React.useCallback((rows: number, cols: number) => {
		// Avoid sending duplicate resize events
		if (
			lastSizeRef.current?.rows === rows &&
			lastSizeRef.current?.cols === cols
		) {
			return;
		}

		// Debounce resize events to avoid loops
		if (resizeTimeoutRef.current) {
			clearTimeout(resizeTimeoutRef.current);
		}

		resizeTimeoutRef.current = setTimeout(() => {
			// Check again after debounce in case size stabilized
			if (
				lastSizeRef.current?.rows === rows &&
				lastSizeRef.current?.cols === cols
			) {
				return;
			}
			lastSizeRef.current = { rows, cols };

			if (wsRef.current?.readyState === WebSocket.OPEN) {
				wsRef.current.send(
					JSON.stringify({ type: "resize", data: { rows, cols } }),
				);
			}
		}, 150);
	}, []);

	// Handle window/container resize
	React.useEffect(() => {
		let rafId: number | null = null;

		const handleResize = () => {
			if (rafId) {
				cancelAnimationFrame(rafId);
			}
			rafId = requestAnimationFrame(() => {
				if (fitAddonRef.current && xtermRef.current) {
					try {
						fitAddonRef.current.fit();
						sendResize(xtermRef.current.rows, xtermRef.current.cols);
					} catch {
						// Ignore fit errors during rapid resizing
					}
				}
			});
		};

		window.addEventListener("resize", handleResize);

		// Also observe the terminal container for size changes
		const resizeObserver = new ResizeObserver(() => {
			handleResize();
		});

		if (terminalRef.current) {
			resizeObserver.observe(terminalRef.current);
		}

		return () => {
			window.removeEventListener("resize", handleResize);
			resizeObserver.disconnect();
			if (rafId) {
				cancelAnimationFrame(rafId);
			}
		};
	}, [sendResize]);

	// Initialize terminal
	React.useEffect(() => {
		let mounted = true;

		const initTerminal = async () => {
			if (!terminalRef.current || xtermRef.current) return;

			const { Terminal } = await import("@xterm/xterm");
			const { FitAddon } = await import("@xterm/addon-fit");
			const { WebLinksAddon } = await import("@xterm/addon-web-links");

			if (!mounted || !terminalRef.current) return;

			const term = new Terminal({
				cursorBlink: true,
				cursorStyle: "block",
				fontSize: 13,
				fontFamily:
					'"JetBrains Mono", "Fira Code", "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Liberation Mono", Menlo, Courier, monospace',
				theme: {
					background: "hsl(var(--background))",
					foreground: "hsl(var(--foreground))",
					cursor: "hsl(var(--foreground))",
					cursorAccent: "hsl(var(--background))",
					selectionBackground: "hsl(var(--accent))",
					black: "#1e1e2e",
					red: "#f38ba8",
					green: "#a6e3a1",
					yellow: "#f9e2af",
					blue: "#89b4fa",
					magenta: "#cba6f7",
					cyan: "#94e2d5",
					white: "#cdd6f4",
					brightBlack: "#585b70",
					brightRed: "#f38ba8",
					brightGreen: "#a6e3a1",
					brightYellow: "#f9e2af",
					brightBlue: "#89b4fa",
					brightMagenta: "#cba6f7",
					brightCyan: "#94e2d5",
					brightWhite: "#a6adc8",
				},
				allowProposedApi: true,
				scrollback: 5000,
			});

			const fitAddon = new FitAddon();
			const webLinksAddon = new WebLinksAddon();

			term.loadAddon(fitAddon);
			term.loadAddon(webLinksAddon);

			term.open(terminalRef.current);
			fitAddon.fit();

			xtermRef.current = term;
			fitAddonRef.current = fitAddon;

			// Forward all input to WebSocket
			term.onData((data) => {
				sendInput(data);
			});

			// Signal that terminal is ready for connection
			setTerminalReady(true);
		};

		initTerminal();

		return () => {
			mounted = false;
			setTerminalReady(false);
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (resizeTimeoutRef.current) {
				clearTimeout(resizeTimeoutRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
				wsRef.current = null;
			}
			if (xtermRef.current) {
				xtermRef.current.dispose();
				xtermRef.current = null;
			}
		};
	}, [sendInput]);

	// Connect/reconnect when sessionId or root changes
	React.useEffect(() => {
		if (!terminalReady || !xtermRef.current) return;

		const sessionChanged = prevSessionIdRef.current !== sessionId;
		const rootChanged = prevRootRef.current !== root;

		// Update refs
		prevSessionIdRef.current = sessionId;
		prevRootRef.current = root;

		// Connect if we have a session and either it's initial or something changed
		if (sessionId && (sessionChanged || rootChanged)) {
			xtermRef.current.clear();
			connect(xtermRef.current);
		}
	}, [terminalReady, sessionId, root, connect]);

	const statusColor =
		connectionStatus === "connected"
			? "bg-green-500"
			: connectionStatus === "connecting"
				? "bg-yellow-500"
				: connectionStatus === "error"
					? "bg-red-500"
					: "bg-gray-500";

	// Copy SSH command to clipboard
	const handleCopySSH = React.useCallback(async () => {
		if (!sessionId) return;

		const host = getSSHHost();
		const sshLocation = `ssh -p 3333 ${sessionId}@${host}`;

		try {
			await navigator.clipboard.writeText(sshLocation);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (error) {
			console.error("Failed to copy SSH location:", error);
		}
	}, [sessionId]);

	return (
		<div className={cn("flex flex-col h-full bg-background", className)}>
			{!hideHeader && (
				<div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background">
					<div className="flex items-center gap-2">
						<div className="flex gap-1.5">
							<div className="w-3 h-3 rounded-full bg-red-500" />
							<div className="w-3 h-3 rounded-full bg-yellow-500" />
							<div className="w-3 h-3 rounded-full bg-green-500" />
						</div>
						<span className="text-xs text-muted-foreground ml-2">
							{sessionId
								? `Session: ${sessionId.slice(0, 8)}...`
								: "No session"}
						</span>
						<div
							className={cn("w-2 h-2 rounded-full", statusColor)}
							title={connectionStatus}
						/>
					</div>
					<div className="flex items-center gap-2">
						{sessionId && (
							<Button
								variant="ghost"
								size="sm"
								onClick={handleCopySSH}
								className="gap-2 h-6 px-2 text-xs"
								title={`Copy SSH command: ssh -p 3333 ${sessionId}@${getSSHHost()}`}
							>
								{copied ? (
									<Check className="h-3 w-3" />
								) : (
									<Copy className="h-3 w-3" />
								)}
								<span className="hidden sm:inline">
									{copied ? "Copied!" : "Copy SSH"}
								</span>
							</Button>
						)}
						{onToggleChat && (
							<Button
								variant="ghost"
								size="sm"
								onClick={onToggleChat}
								className="gap-2"
							>
								<MessageSquare className="h-4 w-4" />
								<span className="hidden sm:inline">Back to Chat</span>
							</Button>
						)}
					</div>
				</div>
			)}

			<div ref={terminalRef} className="flex-1 min-h-0 overflow-hidden" />
		</div>
	);
});
