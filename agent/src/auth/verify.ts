import { createHash } from "node:crypto";

/**
 * Verifies a plaintext secret against a salted SHA-256 hash.
 * The hashedSecret should be in "salt:hash" format as produced by the Go hashSecret function.
 *
 * @param plaintext - The plaintext secret to verify (from Authorization bearer token)
 * @param hashedSecret - The salted hash in "salt:hash" format (hex-encoded)
 * @returns true if the plaintext matches the hash, false otherwise
 */
export function verifySecret(plaintext: string, hashedSecret: string): boolean {
	const parts = hashedSecret.split(":");
	if (parts.length !== 2) {
		return false;
	}

	const [saltHex, expectedHash] = parts;

	// Decode salt from hex
	let salt: Buffer;
	try {
		salt = Buffer.from(saltHex, "hex");
	} catch {
		return false;
	}

	// Compute SHA-256 hash of salt + plaintext
	const hash = createHash("sha256");
	hash.update(salt);
	hash.update(plaintext);
	const computedHash = hash.digest("hex");

	// Constant-time comparison to prevent timing attacks
	return constantTimeEqual(computedHash, expectedHash);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}
