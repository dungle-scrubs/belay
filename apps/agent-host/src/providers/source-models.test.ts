import assert from "node:assert/strict";
import { LM_STUDIO_NATIVE_LIST } from "@belay/test-kit/lmstudio";
import { afterEach, test } from "vitest";
import { fetchSourceModels } from "./source-models";

/**
 * The per-source live `/models` fetch (M1 / D-001, D-005, D-006). The local (LM Studio) source reads
 * the NATIVE `/api/v0/models` endpoint so the catalog carries quantization / type / arch / context /
 * capabilities; cloud/gateway/api-key sources stay on the OpenAI `/v1/models` id+name list. A native
 * fetch that is unreachable, non-OK, or garbled degrades to the id-only shape with the source marked
 * stale - never a dropped model. `fetch` is stubbed so the path is exercised hermetically.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub `fetch` with a per-URL responder and capture the URLs the code requested. */
function stubFetch(responder: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const res = responder(url);
    return {
      ok: res.ok,
      status: res.status ?? (res.ok ? 200 : 500),
      json: async () => res.body ?? {},
    } as Response;
  }) as typeof fetch;
  return calls;
}

test("the local source reads /api/v0/models and enriches each model with its native record", async () => {
  const calls = stubFetch((url) =>
    url.includes("/api/v0/models")
      ? { ok: true, body: LM_STUDIO_NATIVE_LIST }
      : { ok: false, status: 404 },
  );
  const { models, stale } = await fetchSourceModels({ type: "local" }, null);

  assert.equal(stale, false);
  assert.ok(
    calls.some((u) => u.includes("/api/v0/models")),
    "the local fetch hits the native /api/v0/models endpoint",
  );
  assert.ok(
    !calls.some((u) => /\/v1\/models$/.test(u)),
    "the local fetch does NOT use the OpenAI /v1/models list",
  );

  // Every model comes back distinct, each carrying its native record (the two same-id quants differ
  // by quantization + context; the VLM carries its type).
  assert.deepEqual(
    models.map((m) => m.id),
    LM_STUDIO_NATIVE_LIST.data.map((m) => m.id),
  );
  assert.equal(models[0]?.native?.quantization, "8bit");
  assert.equal(models[0]?.native?.type, "llm");
  assert.equal(models[0]?.native?.arch, "qwen3");
  assert.equal(models[0]?.native?.maxContextLength, 262144);
  assert.deepEqual(models[0]?.native?.capabilities, ["tool_use"]);
  assert.equal(models[1]?.native?.quantization, "4bit");
  assert.equal(models[1]?.native?.maxContextLength, 65536);
  assert.equal(models[2]?.native?.type, "vlm");
});

test("an UNREACHABLE LM Studio yields an empty, stale local source with NO doomed /v1 retry", async () => {
  // The native fetch rejects (connection refused) - LM Studio isn't running. The id-only /v1 list
  // targets the same dead host, so it must NOT be attempted (it would only waste a round-trip).
  const calls = stubFetch((url) => {
    if (url.includes("/api/v0/models")) {
      throw new Error("connection refused");
    }
    return { ok: true, body: { data: [{ id: "unsloth/qwen3.6-27b-mlx" }] } };
  });
  const { models, stale } = await fetchSourceModels({ type: "local" }, null);

  assert.equal(stale, true, "an unreachable native endpoint marks the source stale");
  assert.deepEqual(models, [], "an unreachable LM Studio lists no models");
  assert.ok(
    !calls.some((u) => /\/v1\/models$/.test(u)),
    "the doomed /v1/models fallback is skipped when the host is unreachable",
  );
});

test("a REACHABLE-but-non-OK /api/v0 (older LM Studio) degrades to the id-only /v1 list + stale", async () => {
  // The native endpoint answers non-OK (no /api/v0 on this build), but the host is up, so the id-only
  // /v1/models list IS worth trying and still lists the models (D-006).
  const calls = stubFetch((url) => {
    if (url.includes("/api/v0/models")) {
      return { ok: false, status: 503 };
    }
    return { ok: true, body: { data: [{ id: "qwen/qwen3-vl-8b" }] } };
  });
  const { models, stale } = await fetchSourceModels({ type: "local" }, null);
  assert.equal(stale, true);
  assert.deepEqual(
    models.map((m) => m.id),
    ["qwen/qwen3-vl-8b"],
    "the model is still listed via the id-only fallback",
  );
  assert.equal(models[0]?.native, undefined, "no native record on the degraded entry");
  assert.ok(
    calls.some((u) => /\/v1\/models$/.test(u)),
    "the reachable-but-no-native path falls back to /v1/models",
  );
});

test("cloud/gateway sources keep the OpenAI /v1/models id+name list (no native endpoint)", async () => {
  const calls = stubFetch((url) =>
    /\/v1\/models$/.test(url)
      ? { ok: true, body: { data: [{ id: "glm-5.2", name: "GLM 5.2" }] } }
      : { ok: false, status: 404 },
  );
  const { models, stale } = await fetchSourceModels(
    { type: "api-key", piProvider: "zai", baseUrl: "https://api.z.ai/v1" },
    "sk-zai-test",
  );

  assert.equal(stale, false);
  assert.ok(
    !calls.some((u) => u.includes("/api/v0")),
    "a cloud source never touches the LM-Studio-only /api/v0 endpoint",
  );
  assert.deepEqual(models, [{ id: "glm-5.2", name: "GLM 5.2" }]);
});
