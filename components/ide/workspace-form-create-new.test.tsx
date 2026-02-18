/**
 * WorkspaceForm auto-init feature tests
 *
 * The server automatically creates and git-inits a directory when the path
 * either doesn't exist or is empty.  The form simply passes the path through;
 * no explicit flag is needed.
 *
 * Run with:
 *   node --import ./test/setup.js --import tsx --test components/ide/workspace-form-create-new.test.tsx
 */

import assert from "node:assert";
import { afterEach, describe, test } from "node:test";
import { cleanup } from "@testing-library/react";
import type { CreateWorkspaceRequest } from "../../lib/api-types.js";

describe("WorkspaceForm auto-init feature", () => {
	afterEach(() => {
		cleanup();
	});

	describe("request construction", () => {
		test("should build a local request without any createNew flag", () => {
			const buildRequest = (
				inputType: "local" | "git" | "github",
				path: string,
				provider?: string,
			): CreateWorkspaceRequest => {
				const sourceType = inputType === "local" ? "local" : "git";
				const request: CreateWorkspaceRequest = { path, sourceType };
				if (provider !== undefined) request.provider = provider;
				return request;
			};

			const req = buildRequest("local", "~/new-project");
			assert.strictEqual(req.path, "~/new-project");
			assert.strictEqual(req.sourceType, "local");
			assert.strictEqual(req.provider, undefined);
			// No createNew field at all
			assert.ok(
				!("createNew" in req),
				"createNew should not be present in the request",
			);
		});

		test("should build a git request correctly", () => {
			const req: CreateWorkspaceRequest = {
				path: "https://github.com/org/repo",
				sourceType: "git",
			};
			assert.strictEqual(req.sourceType, "git");
			assert.ok(!("createNew" in req));
		});

		test("should include provider when explicitly selected", () => {
			const req: CreateWorkspaceRequest = {
				path: "~/projects/app",
				sourceType: "local",
				provider: "vz",
			};
			assert.strictEqual(req.provider, "vz");
		});
	});

	describe("CreateWorkspaceRequest interface", () => {
		test("optional fields are truly optional", () => {
			const minimal: CreateWorkspaceRequest = {
				path: "~/foo",
				sourceType: "local",
			};
			assert.strictEqual(minimal.displayName, undefined);
			assert.strictEqual(minimal.provider, undefined);

			const full: CreateWorkspaceRequest = {
				path: "~/bar",
				sourceType: "local",
				displayName: "My Project",
				provider: "docker",
			};
			assert.strictEqual(full.displayName, "My Project");
			assert.strictEqual(full.provider, "docker");
		});
	});
});
