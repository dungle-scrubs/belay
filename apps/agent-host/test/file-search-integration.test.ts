import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFileIndex } from "@host/file-mention/file-index";
import {
  decodeTrevorEvent,
  events,
  type SessionEvent,
  searchWorkspaceFiles,
} from "@trevor/session";
import { test } from "vitest";

/**
 * Integration (plan 30 M5): the whole host-side file-search path over a REAL temp workspace - the
 * host's index builder feeds `events.fileIndexResult`, which decodes back exactly as the browser
 * reads it, and the shared fuzzy search finds a file in the decoded index. Exercises the host
 * enumeration + the wire contract + the browser search together, without booting the full host.
 */

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "file-mention-e2e-"));
  for (const rel of [
    "apps/web/src/app.tsx",
    "apps/web/src/hooks/use-composer.ts",
    "apps/agent-host/src/main.ts",
    "README.md",
    "node_modules/dep/index.js",
    ".git/config",
  ]) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x", "utf8");
  }
  return root;
}

function stored(input: ReturnType<typeof events.fileIndexResult>): SessionEvent {
  return {
    sessionId: "s",
    seq: 1,
    eventId: "ev-1",
    producerId: "host",
    createdAt: "2026-01-01T00:00:00.000Z",
    type: input.type,
    payload: input.payload as Record<string, unknown>,
  };
}

test("host index over a temp workspace round-trips the wire and is searchable by the browser", () => {
  const root = tempWorkspace();

  // Host side: enumerate the workspace (ignore policy prunes node_modules / .git).
  const index = buildFileIndex({ root });
  const relPaths = index.files.map((f) => f.path);
  assert.ok(relPaths.includes("apps/web/src/hooks/use-composer.ts"));
  assert.ok(relPaths.includes("README.md"));
  assert.ok(!relPaths.some((p) => p.includes("node_modules")));
  assert.ok(!relPaths.some((p) => p.includes(".git/")));

  // Wire: the result event decodes back to exactly the relative paths the browser searches.
  const decoded = decodeTrevorEvent(
    stored(
      events.fileIndexResult({
        requestId: "req-1",
        files: index.files,
        truncated: index.truncated,
      }),
    ),
  );
  assert.equal(decoded?.type, "file.index.result");
  const wirePaths = decoded?.type === "file.index.result" ? decoded.files.map((f) => f.path) : [];
  assert.deepEqual(wirePaths, relPaths);

  // Browser side: the shared fuzzy search finds the composer hook by a basename query.
  const found =
    decoded?.type === "file.index.result"
      ? searchWorkspaceFiles(decoded.files, "usecomposer", 10)
      : null;
  assert.equal(found?.matches[0]?.path, "apps/web/src/hooks/use-composer.ts");
});
