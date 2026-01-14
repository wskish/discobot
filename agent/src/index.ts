import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Configuration from environment
const AGENT_COMMAND = process.env.AGENT_COMMAND || "claude-code-acp";
const AGENT_ARGS = process.env.AGENT_ARGS?.split(" ").filter(Boolean) || [];
const AGENT_CWD = process.env.AGENT_CWD || process.cwd();
const PORT = Number(process.env.PORT) || 3001;

const { app } = createApp({
	agentCommand: AGENT_COMMAND,
	agentArgs: AGENT_ARGS,
	agentCwd: AGENT_CWD,
	enableLogging: true,
});

console.log(`Starting agent service on port ${PORT}`);
console.log(`Agent command: ${AGENT_COMMAND} ${AGENT_ARGS.join(" ")}`);
console.log(`Agent cwd: ${AGENT_CWD}`);

serve({
	fetch: app.fetch,
	port: PORT,
});
