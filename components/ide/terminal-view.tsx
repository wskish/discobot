"use client";

import { MessageSquare } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface TerminalViewProps {
	className?: string;
	onToggleChat?: () => void;
	hideHeader?: boolean;
}

export function TerminalView({
	className,
	onToggleChat,
	hideHeader,
}: TerminalViewProps) {
	const terminalRef = React.useRef<HTMLDivElement>(null);
	const xtermRef = React.useRef<import("@xterm/xterm").Terminal | null>(null);
	const fitAddonRef = React.useRef<import("@xterm/addon-fit").FitAddon | null>(
		null,
	);
	const [_isReady, setIsReady] = React.useState(false);
	const currentLineRef = React.useRef("");
	const historyRef = React.useRef<string[]>([]);
	const historyIndexRef = React.useRef(-1);

	// Handle window resize
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
	}, []);

	// Initialize terminal
	React.useEffect(() => {
		let mounted = true;

		const writePrompt = (term: import("@xterm/xterm").Terminal) => {
			term.write("\x1b[1;32muser@dev-server\x1b[0m:\x1b[1;34m~\x1b[0m$ ");
		};

		const executeCommand = async (
			term: import("@xterm/xterm").Terminal,
			command: string,
		) => {
			try {
				const result = await api.executeCommand(command);

				if (result.output) {
					// Handle ANSI colors and formatting
					const lines = result.output.split("\n");
					for (const line of lines) {
						term.writeln(line);
					}
				}
			} catch {
				term.writeln(`\x1b[31mError executing command: ${command}\x1b[0m`);
			}
		};

		const handleInput = async (
			term: import("@xterm/xterm").Terminal,
			data: string,
		) => {
			const code = data.charCodeAt(0);

			// Enter key
			if (code === 13) {
				term.writeln("");
				const command = currentLineRef.current.trim();

				if (command) {
					historyRef.current.push(command);
					historyIndexRef.current = historyRef.current.length;
					await executeCommand(term, command);
				}

				currentLineRef.current = "";
				writePrompt(term);
				return;
			}

			// Backspace
			if (code === 127) {
				if (currentLineRef.current.length > 0) {
					currentLineRef.current = currentLineRef.current.slice(0, -1);
					term.write("\b \b");
				}
				return;
			}

			// Ctrl+C
			if (code === 3) {
				term.writeln("^C");
				currentLineRef.current = "";
				writePrompt(term);
				return;
			}

			// Ctrl+L (clear)
			if (code === 12) {
				term.clear();
				currentLineRef.current = "";
				writePrompt(term);
				return;
			}

			// Arrow keys (escape sequences)
			if (data === "\x1b[A") {
				// Up arrow - history
				if (historyIndexRef.current > 0) {
					historyIndexRef.current--;
					const historyCmd = historyRef.current[historyIndexRef.current];
					// Clear current line
					term.write("\x1b[2K\r");
					writePrompt(term);
					term.write(historyCmd);
					currentLineRef.current = historyCmd;
				}
				return;
			}

			if (data === "\x1b[B") {
				// Down arrow - history
				if (historyIndexRef.current < historyRef.current.length - 1) {
					historyIndexRef.current++;
					const historyCmd = historyRef.current[historyIndexRef.current];
					term.write("\x1b[2K\r");
					writePrompt(term);
					term.write(historyCmd);
					currentLineRef.current = historyCmd;
				} else {
					historyIndexRef.current = historyRef.current.length;
					term.write("\x1b[2K\r");
					writePrompt(term);
					currentLineRef.current = "";
				}
				return;
			}

			// Tab completion (simplified)
			if (code === 9) {
				// Just ignore tab for now
				return;
			}

			// Regular character
			if (code >= 32) {
				currentLineRef.current += data;
				term.write(data);
			}
		};

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

			// Write welcome message
			term.writeln(
				"\x1b[1;34m╭─────────────────────────────────────────────╮\x1b[0m",
			);
			term.writeln(
				"\x1b[1;34m│\x1b[0m  \x1b[1;32mOctobot Terminal\x1b[0m                           \x1b[1;34m│\x1b[0m",
			);
			term.writeln(
				"\x1b[1;34m│\x1b[0m  \x1b[90mFake SSH - Commands are simulated\x1b[0m          \x1b[1;34m│\x1b[0m",
			);
			term.writeln(
				"\x1b[1;34m╰─────────────────────────────────────────────╯\x1b[0m",
			);
			term.writeln("");

			writePrompt(term);

			// Handle input
			term.onData((data) => {
				handleInput(term, data);
			});

			setIsReady(true);
		};

		initTerminal();

		return () => {
			mounted = false;
			if (xtermRef.current) {
				xtermRef.current.dispose();
				xtermRef.current = null;
			}
		};
	}, []);

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
							SSH: user@dev-server.local
						</span>
					</div>
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
			)}

			<div ref={terminalRef} className="flex-1 p-2" />

			{/* Import xterm CSS via style tag */}
			<style jsx global>{`
        .xterm {
          height: 100%;
          padding: 8px;
        }
        .xterm-viewport {
          overflow-y: auto !important;
        }
        .xterm-screen {
          height: 100%;
        }
      `}</style>
		</div>
	);
}
