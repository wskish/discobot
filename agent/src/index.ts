import { createApp } from "./server/app.js";

// Configuration from environment
const AGENT_COMMAND = process.env.AGENT_COMMAND || "claude-code-acp";
const AGENT_ARGS = process.env.AGENT_ARGS?.split(" ").filter(Boolean) || [];
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
const PORT = Number(process.env.PORT) || 3001;

// Read and clear the shared secret hash from environment
// We clear it so the agent subprocess doesn't see it
const OCTOBOT_SECRET = process.env.OCTOBOT_SECRET;
if (OCTOBOT_SECRET) {
	delete process.env.OCTOBOT_SECRET;
}

const { app } = createApp({
	agentCommand: AGENT_COMMAND,
	agentArgs: AGENT_ARGS,
	agentCwd: AGENT_CWD,
	enableLogging: true,
	sharedSecretHash: OCTOBOT_SECRET,
});

console.log(`Starting agent service on port ${PORT}`);
console.log(`Agent command: ${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`);
console.log(`Agent cwd: ${AGENT_CWD}`);
console.log(`Auth enforcement: ${OCTOBOT_SECRET ? "enabled" : "disabled"}`);

// Use Bun's native serve if available, otherwise fall back to Node
declare const Bun:
	| { serve: (options: { fetch: typeof app.fetch; port: number }) => void }
	| undefined;

if (typeof Bun !== "undefined") {
	Bun.serve({
		fetch: app.fetch,
		port: PORT,
	});
} else {
	// Node.js fallback
	import("@hono/node-server").then(({ serve }) => {
		serve({
			fetch: app.fetch,
			port: PORT,
		});
	});
}
