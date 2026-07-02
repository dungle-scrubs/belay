import assert from "node:assert/strict";
import { ToolInputError } from "@host/tools/errors";
import { test } from "vitest";

/**
 * Responsible for: proving the `@host/*` path alias (plan 22.1 M2, D-007) resolves under the
 * Vitest projects, importing a real host module through the alias.
 * Not for: typecheck-time alias resolution - tsgo reads `paths` from apps/agent-host/tsconfig.json
 * directly, which `pnpm typecheck` covers.
 */

test("@host/* resolves to apps/agent-host/src under Vitest", () => {
  const err = new ToolInputError({ tool: "structure", detail: "alias smoke" });
  assert.equal(err._tag, "ToolInputError");
});
