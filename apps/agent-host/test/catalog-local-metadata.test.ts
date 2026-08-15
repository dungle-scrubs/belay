import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type CatalogEntry, catalogEntryFor } from "@belay/session";
import { LM_STUDIO_NATIVE_LIST, LM_STUDIO_V1_LIST } from "@belay/test-kit/lmstudio";
import { afterEach, test } from "vitest";
import { buildCatalogSnapshot } from "../src/providers/catalog";
import { fetchSourceModels } from "../src/providers/source-models";

/**
 * Integration (09.3 M5): the LOCAL catalog metadata path end to end against a FAKE LM Studio HTTP
 * server, through the real `fetchSourceModels` -> `buildCatalogSnapshot` load path (what `loadCatalog`
 * orchestrates per source). One scenario serves the native `/api/v0/models` and proves quant + live
 * caps + native context reach the catalog; the other takes `/api/v0` down and proves the source falls
 * back to the id-only `/v1/models` list, marked stale, never dropping a model (D-001, D-006).
 */

let server: Server | undefined;
const prevUrl = process.env.LMSTUDIO_URL;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (prevUrl === undefined) {
    delete process.env.LMSTUDIO_URL;
  } else {
    process.env.LMSTUDIO_URL = prevUrl;
  }
});

/** Boot a fake LM Studio on an ephemeral port and point `LMSTUDIO_URL` at its `/v1` base. */
async function startFakeLmStudio(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  process.env.LMSTUDIO_URL = `http://127.0.0.1:${port}/v1`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Build the local catalog the way `loadCatalog` does: fetch the source's live models, then feed them
 *  (and the stale flag) into the pure snapshot builder. */
async function loadLocalCatalog(): Promise<{ entries: readonly CatalogEntry[]; stale: boolean }> {
  const { models, stale } = await fetchSourceModels({ type: "local" }, null);
  const snap = buildCatalogSnapshot(
    {},
    { lmstudio: models },
    stale ? new Set(["lmstudio"]) : new Set(),
  );
  return { entries: snap.catalogBySource.lmstudio ?? [], stale };
}

test("a live /api/v0 makes the local catalog show quantization + live capabilities + native context", async () => {
  await startFakeLmStudio((req, res) => {
    if (req.url === "/api/v0/models") {
      sendJson(res, 200, LM_STUDIO_NATIVE_LIST);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  const { entries, stale } = await loadLocalCatalog();
  assert.equal(stale, false, "a healthy native endpoint is not stale");

  // The two same-id quants are present and tell-apart-able by quantization + native context.
  const q8 = catalogEntryFor(
    { lmstudio: entries },
    {
      sourceId: "lmstudio",
      modelId: "unsloth/qwen3.6-27b-mlx",
    },
  );
  const q4 = catalogEntryFor(
    { lmstudio: entries },
    {
      sourceId: "lmstudio",
      modelId: "lmstudio-community/qwen3.6-27b-mlx",
    },
  );
  assert.equal(q8?.quantization, "8bit");
  assert.equal(q8?.contextLength, 262144);
  assert.ok(q8?.capabilities.includes("tools"), "tool_use -> live Tools capability");
  assert.equal(q4?.quantization, "4bit");
  assert.equal(q4?.contextLength, 65536);

  // The VLM gets a live Vision capability and NOT Tools (its native capabilities lacked tool_use).
  const vl = catalogEntryFor(
    { lmstudio: entries },
    {
      sourceId: "lmstudio",
      modelId: "qwen/qwen3-vl-8b",
    },
  );
  assert.ok(vl?.capabilities.includes("vision"), "type:vlm -> live Vision capability");
  assert.ok(!vl?.capabilities.includes("tools"), "no tool_use -> no Tools capability");
});

test("/api/v0 down falls back to the id-only /v1/models list, marked stale, dropping no models", async () => {
  await startFakeLmStudio((req, res) => {
    if (req.url === "/api/v0/models") {
      sendJson(res, 503, { error: "service unavailable" });
      return;
    }
    if (req.url === "/v1/models") {
      sendJson(res, 200, LM_STUDIO_V1_LIST);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  });

  const { entries, stale } = await loadLocalCatalog();
  assert.equal(stale, true, "an unavailable native endpoint marks the source stale");

  // Every model still lists (the id-only fallback), but with NO fabricated quant/tools/vision.
  assert.deepEqual(
    entries.map((e) => e.modelId),
    LM_STUDIO_NATIVE_LIST.data.map((m) => m.id),
    "no model is dropped on the degraded path",
  );
  for (const entry of entries) {
    assert.ok(
      !("quantization" in entry),
      `${entry.modelId}: no quantization on the degraded entry`,
    );
    assert.ok(!entry.capabilities.includes("tools"), `${entry.modelId}: no fabricated Tools`);
    assert.ok(!entry.capabilities.includes("vision"), `${entry.modelId}: no fabricated Vision`);
    assert.equal(entry.freshness.stale, true, `${entry.modelId}: entry carries the stale flag`);
  }
});
