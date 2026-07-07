import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "vitest";

const REPO = join(import.meta.dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(path));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function rel(path: string): string {
  return relative(REPO, path);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("e2e host-internal imports stay explicit compatibility debt", () => {
  const allowed = new Set([
    "e2e/command-file-dispatch.test.ts",
    "e2e/doctor-smoke.test.ts",
    "e2e/live/source-recall.test.ts",
    "e2e/source-recall-smoke.test.ts",
  ]);
  const violations = walk(join(REPO, "e2e"))
    .filter((path) => /from "@host\//.test(read(path)))
    .map(rel)
    .filter((path) => !allowed.has(path));

  assert.deepEqual(violations, [], `new e2e @host imports:\n${violations.join("\n")}`);
});

test("web raw event folds stay behind projection/debug boundaries", () => {
  const allowed = new Set([
    "apps/web/src/components/chat/loop/use-loop-inventory.ts",
    "apps/web/src/derive.ts",
    "apps/web/src/hooks/use-send-queue.ts",
    "apps/web/src/hooks/use-workspace-file-search.ts",
    "apps/web/src/new-session/use-launch.ts",
    "apps/web/src/send-queue.ts",
    "apps/web/src/session/projection.ts",
    "apps/web/src/session/use-session.ts",
    "apps/web/src/tangent/tangent-send.ts",
    "apps/web/src/transcript.ts",
  ]);
  const violations = walk(join(REPO, "apps/web/src"))
    .filter((path) => !/(\.test|\.stories)\.(ts|tsx)$/.test(path))
    .filter((path) =>
      /readonly SessionEvent\[\]|SessionEvent\[\]|events\.(map|filter|find)/.test(read(path)),
    )
    .map(rel)
    .filter((path) => !allowed.has(path));

  assert.deepEqual(
    violations,
    [],
    `raw event folds outside read boundaries:\n${violations.join("\n")}`,
  );
});

test("blob URL and artifact policy stay in artifact runtime bindings", () => {
  const allowed = new Set([
    "apps/agent-host/src/artifacts/runtime.ts",
    "apps/agent-host/src/agent/image-resolution.ts",
    "apps/agent-host/src/tools/video-inspect/tool.ts",
    "apps/trevor-cli/src/main.ts",
    "apps/web/src/blob.ts",
    "packages/session/src/artifact-runtime.ts",
    "packages/session/src/blob.ts",
    "packages/session/src/ports.ts",
  ]);
  const violations = walk(REPO)
    .filter((path) => !/(\.test|\.stories)\.(ts|tsx)$/.test(path))
    .filter((path) =>
      /(process\.env\.BLOB_STORE_URL|VITE_BLOB_STORE_URL|blobUrl\(|putBlob\(|fetchBlobBytes\(|artifactRef\()/.test(
        read(path),
      ),
    )
    .map(rel)
    .filter((path) => !allowed.has(path));

  assert.deepEqual(violations, [], `duplicated blob/artifact policy:\n${violations.join("\n")}`);
});

test("CLI process entrypoint delegates command dispatch to the router", () => {
  const main = read(join(REPO, "apps/trevor-cli/src/main.ts"));
  const router = read(join(REPO, "apps/trevor-cli/src/command-router.ts"));

  assert.ok(router.includes("COMMAND_SPECS"), "command router owns command metadata");
  assert.equal(/if \(cmd ===/.test(main), false, "main.ts must not own command dispatch branches");
  assert.equal(/MIME_BY_EXT/.test(main), false, "main.ts must not own artifact MIME inference");
});
