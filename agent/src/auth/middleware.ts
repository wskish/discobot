import type { Context, Next } from "hono";
import { verifySecret } from "./verify.js";

/**
 * Creates an authentication middleware that validates Bearer tokens against a salted hash.
 *
 * When OCTOBOT_SECRET env var is set (as a salted hash), this middleware requires
 * all requests to include an Authorization header with a Bearer token that verifies
 * against the hash.
 *
 * @param hashedSecret - The salted hash from OCTOBOT_SECRET env var, or undefined/empty to skip auth
 * @returns Hono middleware function
 */
export function authMiddleware(hashedSecret: string | undefined) {
	return async (c: Context, next: Next) => {
		// If no secret configured, skip auth
		if (!hashedSecret) {
			return next();
		}

		const authHeader = c.req.header("Authorization");

		if (!authHeader) {
			return c.json({ error: "Authorization header required" }, 401);
		}

		// Parse Bearer token
		const match = authHeader.match(/^Bearer\s+(.+)$/i);
		if (!match) {
			return c.json(
				{
					error:
						"Invalid Authorization header format. Expected: Bearer <token>",
				},
				401,
			);
		}

		const token = match[1];

		// Verify token against the salted hash
		if (!verifySecret(token, hashedSecret)) {
			return c.json({ error: "Invalid authorization token" }, 401);
		}

		return next();
	};
}
