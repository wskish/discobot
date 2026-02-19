import os from "node:os";
import { type Context, Hono } from "hono";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import type { Agent } from "../agent/interface.js";
import type {
	ChatRequest,
	ChatStatusResponse,
	ClearSessionResponse,
	CommitsErrorResponse,
	CommitsResponse,
	DeleteFileRequest,
	DeleteFileResponse,
	DiffFilesResponse,
	DiffResponse,
	ErrorResponse,
	GetMessagesResponse,
	HealthResponse,
	ListFilesResponse,
	ListServicesResponse,
	ModelsResponse,
	ReadFileResponse,
	RenameFileRequest,
	RenameFileResponse,
	RootResponse,
	ServiceAlreadyRunningResponse,
	ServiceIsPassiveResponse,
	ServiceNoPortResponse,
	ServiceNotFoundResponse,
	ServiceNotRunningResponse,
	ServiceOutputEvent,
	SingleFileDiffResponse,
	StartServiceResponse,
	StopServiceResponse,
	UserResponse,
	WriteFileRequest,
	WriteFileResponse,
} from "../api/types.js";
import { authMiddleware } from "../auth/middleware.js";
import { ClaudeSDKClient } from "../claude-sdk/client.js";
import { questionManager } from "../claude-sdk/question-manager.js";
import { checkCredentialsChanged } from "../credentials/credentials.js";
import { HookManager } from "../hooks/manager.js";
import {
	getManagedService,
	getService,
	getServiceOutput,
	getServices,
	startService,
	stopService,
} from "../services/manager.js";
import { proxyHttpRequest } from "../services/proxy.js";
import {
	aggregateDeltas,
	getCompletionEvents,
	getCompletionState,
	isCompletionRunning,
} from "../store/session.js";
import { getCommitPatches, isCommitsError } from "./commits.js";
import {
	resetHookState,
	tryCancelCompletion,
	tryStartCompletion,
} from "./completion.js";
import {
	deleteFile,
	getDiff,
	isFileError,
	listDirectory,
	readFile,
	renameFile,
	writeFile,
} from "./files.js";

// Header names for credentials and git config passed from server
const CREDENTIALS_HEADER = "X-Discobot-Credentials";
const GIT_USER_NAME_HEADER = "X-Discobot-Git-User-Name";
const GIT_USER_EMAIL_HEADER = "X-Discobot-Git-User-Email";

export interface AppOptions {
	agentCwd: string;
	enableLogging?: boolean;
	/** Salted hash of shared secret (from DISCOBOT_SECRET env var) for auth enforcement */
	sharedSecretHash?: string;
}

export function createApp(options: AppOptions) {
	const app = new Hono();

	const agent: Agent = new ClaudeSDKClient({
		cwd: options.agentCwd,
		model: process.env.AGENT_MODEL,
		env: process.env as Record<string, string>,
	});

	// Initialize hook manager for file and pre-commit hooks (opt-in via env var).
	// The Go agent binary sets DISCOBOT_HOOKS_ENABLED=true when running in containers.
	// When running locally (e.g. local sandbox provider), hooks are disabled by default.
	let hookManager: HookManager | null = null;
	if (process.env.DISCOBOT_HOOKS_ENABLED === "true") {
		const sessionId = process.env.SESSION_ID || "default";
		hookManager = new HookManager(options.agentCwd, sessionId);
		hookManager.init().catch((err) => {
			console.error("[hooks] Failed to initialize hook manager:", err);
		});
	}

	if (options.enableLogging) {
		app.use("*", logger());
	}

	if (options.sharedSecretHash) {
		app.use("*", authMiddleware(options.sharedSecretHash));
	}

	app.get("/", (c) => {
		return c.json<RootResponse>({ status: "ok", service: "agent" });
	});

	app.get("/health", (c) => {
		return c.json<HealthResponse>({
			healthy: true,
			connected: agent.isConnected,
		});
	});

	// GET /models - List available models from Claude API
	app.get("/models", async (c) => {
		try {
			// Update agent credentials if they changed (same pattern as /chat)
			const credentialsHeader = c.req.header(CREDENTIALS_HEADER) || null;
			const { changed, env: credentialEnv } =
				checkCredentialsChanged(credentialsHeader);
			if (changed) {
				await agent.updateEnvironment(credentialEnv);
			}

			const models = await agent.listModels();
			return c.json<ModelsResponse>({ models });
		} catch (error) {
			console.error("Failed to list models:", error);
			return c.json<ErrorResponse>(
				{
					error: `Failed to list models: ${error instanceof Error ? error.message : String(error)}`,
				},
				500,
			);
		}
	});

	// GET /user - Return current user info for terminal sessions
	app.get("/user", (c) => {
		const userInfo = os.userInfo();
		return c.json<UserResponse>({
			username: userInfo.username,
			uid: userInfo.uid,
			gid: userInfo.gid,
		});
	});

	// Helper to handle GET /chat for both default and session-specific routes
	const handleGetChat = async (c: Context, sessionId?: string) => {
		const accept = c.req.header("Accept") || "";

		// SSE mode: stream completion events for replay
		if (accept.includes("text/event-stream")) {
			// If no completion running, return 204 No Content
			if (!isCompletionRunning()) {
				return c.body(null, 204);
			}

			// Stream all events (past and future) until completion finishes
			return streamSSE(c, async (stream) => {
				// Get initial batch and aggregate deltas for efficient replay
				const initialEvents = getCompletionEvents();
				const aggregatedInitial = aggregateDeltas(initialEvents);

				// Send aggregated initial batch
				for (const event of aggregatedInitial) {
					await stream.writeSSE({
						data: JSON.stringify(event),
					});
				}

				// Track the raw event index (not aggregated) for polling new events
				let lastEventIndex = initialEvents.length;

				const sendNewEvents = async () => {
					const events = getCompletionEvents();
					// Send new events as-is (no aggregation for live streaming)
					while (lastEventIndex < events.length) {
						await stream.writeSSE({
							data: JSON.stringify(events[lastEventIndex]),
						});
						lastEventIndex++;
					}
				};

				// Poll for new events until completion finishes
				while (isCompletionRunning()) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					await sendNewEvents();
				}

				// Send any final events
				await sendNewEvents();

				// Send [DONE] signal
				await stream.writeSSE({ data: "[DONE]" });
			});
		}

		// JSON mode: return all messages
		if (!agent.isConnected) {
			await agent.connect();
		}
		try {
			await agent.ensureSession(sessionId);
		} catch (error) {
			console.error(`Failed to ensure session ${sessionId}:`, error);
			return c.json<ErrorResponse>(
				{
					error: `Failed to create or load session: ${error instanceof Error ? error.message : String(error)}`,
				},
				500,
			);
		}
		const session = agent.getSession(sessionId);
		if (!session) {
			console.error(
				`Session ${sessionId} not found after ensureSession. Available sessions:`,
				agent.listSessions(),
			);
			return c.json<ErrorResponse>({ error: "Session not found" }, 404);
		}
		// When a completion is actively running, the JSONL may contain partial
		// snapshots of the current turn's in-progress assistant message.
		// If we return this partial message in initialMessages, the Vercel AI SDK
		// reuses it as the streaming state base and then appends replay chunks on
		// top, causing duplicate reasoning blocks and garbled ordering.
		// Strip the last message if it's a partial assistant message so the SDK
		// creates a fresh empty message and the stream replay builds it from scratch.
		let messages = session.getMessages();
		if (
			isCompletionRunning() &&
			messages.length > 0 &&
			messages[messages.length - 1].role === "assistant"
		) {
			messages = messages.slice(0, -1);
		}

		return c.json<GetMessagesResponse>({ messages });
	};

	// Helper to handle POST /chat for both default and session-specific routes
	const handlePostChat = async (c: Context, sessionId?: string) => {
		const body = await c.req.json<ChatRequest>();
		const credentialsHeader = c.req.header(CREDENTIALS_HEADER) || null;
		const gitUserName = c.req.header(GIT_USER_NAME_HEADER) || null;
		const gitUserEmail = c.req.header(GIT_USER_EMAIL_HEADER) || null;
		resetHookState();
		const result = tryStartCompletion(
			agent,
			body,
			credentialsHeader,
			gitUserName,
			gitUserEmail,
			body.model,
			body.reasoning,
			sessionId,
			hookManager,
		);
		return c.json(result.response, result.status);
	};

	// Helper to handle DELETE /chat for both default and session-specific routes
	const handleDeleteChat = async (c: Context, sessionId?: string) => {
		await agent.clearSession(sessionId);
		return c.json<ClearSessionResponse>({ success: true });
	};

	// GET /chat - Return messages (JSON) or stream events (SSE) for default session
	// Content negotiation: Accept: text/event-stream returns SSE, otherwise JSON
	app.get("/chat", async (c) => handleGetChat(c));

	// POST /chat - Start completion for default session (runs in background, returns 202 Accepted)
	// Only one completion can run at a time - returns 409 Conflict if busy
	app.post("/chat", async (c) => handlePostChat(c));

	// GET /hooks/status - Get hook evaluation status
	app.get("/hooks/status", async (c) => {
		if (!hookManager) {
			return c.json({ hooks: {}, pendingHooks: [], lastEvaluatedAt: "" });
		}
		const status = await hookManager.getStatus();
		return c.json(status);
	});

	// GET /hooks/:hookId/output - Get hook output log
	app.get("/hooks/:hookId/output", async (c) => {
		if (!hookManager) {
			return c.json<ErrorResponse>({ error: "Hooks not enabled" }, 404);
		}
		const hookId = c.req.param("hookId");
		const output = await hookManager.getHookOutput(hookId);
		if (output === null) {
			return c.json({ output: "" });
		}
		return c.json({ output });
	});

	// POST /hooks/:hookId/rerun - Manually rerun a hook
	app.post("/hooks/:hookId/rerun", async (c) => {
		if (!hookManager) {
			return c.json<ErrorResponse>({ error: "Hooks not enabled" }, 404);
		}
		const hookId = c.req.param("hookId");
		const result = await hookManager.rerunHook(hookId);
		if (!result) {
			return c.json<ErrorResponse>({ error: "Hook not found" }, 404);
		}
		return c.json({ success: result.success, exitCode: result.exitCode });
	});

	// GET /chat/status - Get completion status
	app.get("/chat/status", (c) => {
		return c.json<ChatStatusResponse>(getCompletionState());
	});

	// POST /chat/cancel - Cancel in-progress completion
	app.post("/chat/cancel", (c) => {
		const result = tryCancelCompletion();
		return c.json(result.response, result.status);
	});

	// DELETE /chat - Clear default session and messages
	app.delete("/chat", async (c) => handleDeleteChat(c));

	// Helper to handle GET /chat/question for both default and session-specific routes
	// Supports ?toolUseID=xxx to query for a specific question by approval ID.
	// Returns { status: "pending", question: {...} } if the question is still pending,
	// or { status: "answered", question: null } if already answered or unknown.
	const handleGetQuestion = (c: Context) => {
		const toolUseID = c.req.query("toolUseID");
		const pending = questionManager.getPendingQuestion();

		if (toolUseID) {
			if (pending && pending.toolUseID === toolUseID) {
				return c.json({ status: "pending", question: pending });
			}
			return c.json({ status: "answered", question: null });
		}

		// Legacy: return whatever is pending (no status field)
		return c.json({ question: pending });
	};

	// Helper to handle POST /chat/answer for both default and session-specific routes
	const handlePostAnswer = async (c: Context) => {
		const body = await c.req.json<{
			toolUseID: string;
			answers: Record<string, string>;
		}>();
		const { toolUseID, answers } = body;
		if (!toolUseID || !answers) {
			return c.json({ error: "toolUseID and answers are required" }, 400);
		}
		const success = questionManager.submitAnswer(toolUseID, answers);
		if (!success) {
			return c.json({ error: "No pending question for this toolUseID" }, 404);
		}
		return c.json({ success: true });
	};

	// GET /chat/question - Return the current pending AskUserQuestion (null if none)
	app.get("/chat/question", (c) => handleGetQuestion(c));

	// POST /chat/answer - Submit answers to a pending AskUserQuestion
	app.post("/chat/answer", async (c) => handlePostAnswer(c));

	// Session-specific routes
	// GET /sessions/:id/chat - Return messages for specific session
	app.get("/sessions/:id/chat", async (c) => {
		const sessionId = c.req.param("id");
		return handleGetChat(c, sessionId);
	});

	// POST /sessions/:id/chat - Start completion for specific session
	app.post("/sessions/:id/chat", async (c) => {
		const sessionId = c.req.param("id");
		return handlePostChat(c, sessionId);
	});

	// DELETE /sessions/:id/chat - Clear specific session
	app.delete("/sessions/:id/chat", async (c) => {
		const sessionId = c.req.param("id");
		return handleDeleteChat(c, sessionId);
	});

	// GET /sessions/:id/chat/question - Return pending question for a specific session
	app.get("/sessions/:id/chat/question", (c) => handleGetQuestion(c));

	// POST /sessions/:id/chat/answer - Submit answer for a specific session
	app.post("/sessions/:id/chat/answer", async (c) => handlePostAnswer(c));

	// =========================================================================
	// File System Endpoints
	// =========================================================================

	// GET /files - List directory contents
	app.get("/files", async (c) => {
		const path = c.req.query("path") || ".";
		const hidden = c.req.query("hidden") === "true";

		const result = await listDirectory(path, {
			workspaceRoot: options.agentCwd,
			includeHidden: hidden,
		});

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}
		return c.json<ListFilesResponse>(result);
	});

	// GET /files/read - Read file content
	app.get("/files/read", async (c) => {
		const path = c.req.query("path");
		if (!path) {
			return c.json<ErrorResponse>(
				{ error: "path query parameter required" },
				400,
			);
		}

		const result = await readFile(path, { workspaceRoot: options.agentCwd });

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}
		return c.json<ReadFileResponse>(result);
	});

	// POST /files/write - Write file content
	app.post("/files/write", async (c) => {
		const body = await c.req.json<WriteFileRequest>();

		if (!body.path) {
			return c.json<ErrorResponse>({ error: "path is required" }, 400);
		}
		if (body.content === undefined) {
			return c.json<ErrorResponse>({ error: "content is required" }, 400);
		}

		const result = await writeFile(body.path, body.content, body.encoding, {
			workspaceRoot: options.agentCwd,
		});

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}
		return c.json<WriteFileResponse>(result);
	});

	// POST /files/delete - Delete a file or directory
	app.post("/files/delete", async (c) => {
		const body = await c.req.json<DeleteFileRequest>();

		if (!body.path) {
			return c.json<ErrorResponse>({ error: "path is required" }, 400);
		}

		const result = await deleteFile(body.path, {
			workspaceRoot: options.agentCwd,
		});

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}
		return c.json<DeleteFileResponse>(result);
	});

	// POST /files/rename - Rename/move a file or directory
	app.post("/files/rename", async (c) => {
		const body = await c.req.json<RenameFileRequest>();

		if (!body.oldPath) {
			return c.json<ErrorResponse>({ error: "oldPath is required" }, 400);
		}
		if (!body.newPath) {
			return c.json<ErrorResponse>({ error: "newPath is required" }, 400);
		}

		const result = await renameFile(body.oldPath, body.newPath, {
			workspaceRoot: options.agentCwd,
		});

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}
		return c.json<RenameFileResponse>(result);
	});

	// GET /diff - Get session diff
	// Query params:
	//   - path: optional single file path to get diff for
	//   - format: "full" (default) or "files" (file list only)
	// The merge-base is calculated automatically by fetching origin and finding
	// the common ancestor between HEAD and the workspace branch.
	app.get("/diff", async (c) => {
		const path = c.req.query("path");
		const format = c.req.query("format") as "full" | "files" | undefined;

		const result = await getDiff(options.agentCwd, {
			path,
			format,
		});

		if (isFileError(result)) {
			return c.json<ErrorResponse>({ error: result.error }, result.status);
		}

		// Type narrow based on what was returned
		if (path) {
			return c.json<SingleFileDiffResponse>(result as SingleFileDiffResponse);
		}
		if (format === "files") {
			return c.json<DiffFilesResponse>(result as DiffFilesResponse);
		}
		return c.json<DiffResponse>(result as DiffResponse);
	});

	// =========================================================================
	// Git Commits Endpoint (for commit workflow)
	// =========================================================================

	// GET /commits - Get format-patch output for commits since a parent
	// Used by the commit workflow to export commits from sandbox to workspace
	app.get("/commits", async (c) => {
		const parent = c.req.query("parent");
		if (!parent) {
			return c.json<CommitsErrorResponse>(
				{
					error: "invalid_parent",
					message: "parent query parameter is required",
				},
				400,
			);
		}

		const result = await getCommitPatches(options.agentCwd, parent);

		if (isCommitsError(result)) {
			// Map error types to HTTP status codes
			const statusMap: Record<CommitsErrorResponse["error"], number> = {
				invalid_parent: 400,
				not_git_repo: 400,
				parent_mismatch: 409, // Conflict - parent doesn't match
				no_commits: 404, // Not found - no commits to return
			};
			return c.json<CommitsErrorResponse>(
				result,
				statusMap[result.error] as 400 | 404 | 409,
			);
		}

		return c.json<CommitsResponse>(result);
	});

	// =========================================================================
	// Service Management Endpoints
	// =========================================================================

	// GET /services - List all services with status
	app.get("/services", async (c) => {
		const services = await getServices(options.agentCwd);
		return c.json<ListServicesResponse>({ services });
	});

	// POST /services/:id/start - Start a service
	app.post("/services/:id/start", async (c) => {
		const serviceId = c.req.param("id");

		// Check if this is a passive service
		const service = await getService(options.agentCwd, serviceId);
		if (service?.passive) {
			return c.json<ServiceIsPassiveResponse>(
				{
					error: "service_is_passive",
					serviceId,
					message:
						"Passive services are externally managed and cannot be started",
				},
				400,
			);
		}

		const result = await startService(options.agentCwd, serviceId);

		if (!result.ok) {
			if (result.status === 404) {
				return c.json<ServiceNotFoundResponse>(
					result.response as ServiceNotFoundResponse,
					404,
				);
			}
			return c.json<ServiceAlreadyRunningResponse>(
				result.response as ServiceAlreadyRunningResponse,
				409,
			);
		}

		return c.json<StartServiceResponse>(result.response, 202);
	});

	// POST /services/:id/stop - Stop a service
	app.post("/services/:id/stop", async (c) => {
		const serviceId = c.req.param("id");

		// Check if this is a passive service
		const service = await getService(options.agentCwd, serviceId);
		if (service?.passive) {
			return c.json<ServiceIsPassiveResponse>(
				{
					error: "service_is_passive",
					serviceId,
					message:
						"Passive services are externally managed and cannot be stopped",
				},
				400,
			);
		}

		const result = await stopService(serviceId);

		if (!result.ok) {
			if (result.status === 404) {
				return c.json<ServiceNotFoundResponse>(
					result.response as ServiceNotFoundResponse,
					404,
				);
			}
			return c.json<ServiceNotRunningResponse>(
				result.response as ServiceNotRunningResponse,
				400,
			);
		}

		return c.json<StopServiceResponse>(result.response, 200);
	});

	// GET /services/:id/output - Stream service output via SSE
	app.get("/services/:id/output", async (c) => {
		const serviceId = c.req.param("id");

		// Check if this is a passive service
		const service = await getService(options.agentCwd, serviceId);
		if (service?.passive) {
			return c.json<ServiceIsPassiveResponse>(
				{
					error: "service_is_passive",
					serviceId,
					message:
						"Passive services are externally managed and have no output logs",
				},
				400,
			);
		}

		const managed = getManagedService(serviceId);

		return streamSSE(c, async (stream) => {
			// Send buffered events from file first (replay)
			const storedEvents = await getServiceOutput(serviceId);
			for (const event of storedEvents) {
				await stream.writeSSE({ data: JSON.stringify(event) });
			}

			// If no running service, send done and close
			if (!managed) {
				await stream.writeSSE({ data: "[DONE]" });
				return;
			}

			// If already stopped, send done and close
			if (managed.service.status === "stopped") {
				await stream.writeSSE({ data: "[DONE]" });
				return;
			}

			// Stream live events
			const onOutput = async (event: ServiceOutputEvent) => {
				try {
					await stream.writeSSE({ data: JSON.stringify(event) });
				} catch {
					// Stream may be closed
				}
			};

			const onClose = async () => {
				try {
					await stream.writeSSE({ data: "[DONE]" });
				} catch {
					// Stream may be closed
				}
			};

			managed.eventEmitter.on("output", onOutput);
			managed.eventEmitter.once("close", onClose);

			// Wait for close event or client disconnect
			await new Promise<void>((resolve) => {
				const cleanup = () => {
					managed.eventEmitter.off("output", onOutput);
					managed.eventEmitter.off("close", onClose);
					resolve();
				};

				managed.eventEmitter.once("close", cleanup);

				// Handle client disconnect
				c.req.raw.signal.addEventListener("abort", cleanup);
			});
		});
	});

	// ALL /services/:id/http/* - HTTP reverse proxy to service port
	// Supports all HTTP methods and rewrites path based on x-forwarded-path header
	// Note: WebSocket upgrades are handled at the Bun.serve level in index.ts
	// Auto-starts non-passive services on demand
	app.all("/services/:id/http/*", async (c) => {
		const serviceId = c.req.param("id");
		const service = await getService(options.agentCwd, serviceId);

		if (!service) {
			return c.json<ServiceNotFoundResponse>(
				{ error: "service_not_found", serviceId },
				404,
			);
		}

		const port = service.http || service.https;
		if (!port) {
			return c.json<ServiceNoPortResponse>(
				{ error: "service_no_port", serviceId },
				400,
			);
		}

		// For non-passive services that aren't running, auto-start them
		if (!service.passive && service.status !== "running") {
			// Start the service
			const startResult = await startService(options.agentCwd, serviceId);

			if (!startResult.ok) {
				// If already running (race condition), continue to proxy
				if (startResult.status !== 409) {
					return c.json(startResult.response, startResult.status);
				}
			}

			// Return the "waiting for service" HTML page which will auto-refresh
			// The proxy will return connection_refused until the service is ready
		}

		// Proxy the request - if service isn't ready yet, proxy.ts will return
		// the auto-refreshing HTML page for connection_refused errors
		return proxyHttpRequest(c, port);
	});

	/**
	 * Get the HTTP port for a service, auto-starting if needed.
	 * Used by the WebSocket proxy in index.ts to get target port.
	 * For passive services, always returns the port (they're externally managed).
	 * For non-passive services, auto-starts if not running.
	 */
	async function getServicePort(serviceId: string): Promise<number | null> {
		const service = await getService(options.agentCwd, serviceId);
		if (!service) return null;

		const port = service.http || service.https;
		if (!port) return null;

		// Passive services don't need to be running
		if (service.passive) return port;

		// For non-passive services, auto-start if not running
		if (service.status !== "running") {
			const startResult = await startService(options.agentCwd, serviceId);
			// If start failed (and not already running), return null
			if (!startResult.ok && startResult.status !== 409) {
				return null;
			}
		}

		return port;
	}

	return { app, agent, getServicePort };
}
