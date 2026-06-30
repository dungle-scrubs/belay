import type { CatalogEntry } from "@trevor/session";

/**
 * Shared LM Studio native `/api/v0` catalog fixtures (09.3 M5). ONE source of truth for the two
 * same-id `qwen3.6-27b-mlx` quants + a VLM, so the native wire shape and the CatalogEntry shape the
 * catalog derives from it are described in exactly one place and can't drift apart across the tests
 * that exercise them:
 *
 * - the source-models unit test stubs `fetch` with {@link LM_STUDIO_NATIVE_LIST},
 * - the agent-host integration test serves it from a fake `/api/v0/models`,
 * - the web chooser test renders {@link LM_STUDIO_LOCAL_ENTRIES} (the derived shape).
 *
 * Depends only on `@trevor/session` types, so the web jsdom project imports it the same as node tests.
 */

/** The raw `/api/v0/models` LIST response LM Studio returns (snake_case wire shape, OpenAI-style
 *  `{ object, data }` envelope with the native extras the `/v1/models` list omits). */
export const LM_STUDIO_NATIVE_LIST = {
  object: "list",
  data: [
    {
      id: "unsloth/qwen3.6-27b-mlx",
      object: "model",
      type: "llm",
      arch: "qwen3",
      quantization: "8bit",
      state: "loaded",
      max_context_length: 262144,
      loaded_context_length: 262144,
      capabilities: ["tool_use"],
    },
    {
      id: "lmstudio-community/qwen3.6-27b-mlx",
      object: "model",
      type: "llm",
      arch: "qwen3",
      quantization: "4bit",
      state: "not-loaded",
      max_context_length: 65536,
      capabilities: ["tool_use"],
    },
    {
      id: "qwen/qwen3-vl-8b",
      object: "model",
      type: "vlm",
      arch: "qwen3-vl",
      quantization: "4bit",
      state: "not-loaded",
      max_context_length: 128000,
      capabilities: [],
    },
  ],
} as const;

/** The id-only `/v1/models` LIST response LM Studio's OpenAI-compatible endpoint returns - the
 *  degraded shape the catalog falls back to when `/api/v0` is unreachable (D-006). */
export const LM_STUDIO_V1_LIST = {
  object: "list",
  data: LM_STUDIO_NATIVE_LIST.data.map((m) => ({
    id: m.id,
    object: "model",
    owned_by: "lmstudio",
  })),
} as const;

/** The CatalogEntry shape the catalog DERIVES from {@link LM_STUDIO_NATIVE_LIST} (what the chooser
 *  renders): tools from `tool_use`, vision from `type: "vlm"`, context from `max_context_length`, plus
 *  the local-only `quantization` + `arch`. Kept in lockstep with the wire fixture above. */
export const LM_STUDIO_LOCAL_ENTRIES: readonly CatalogEntry[] = [
  {
    sourceId: "lmstudio",
    modelId: "unsloth/qwen3.6-27b-mlx",
    displayName: "unsloth/qwen3.6-27b-mlx",
    kind: "local",
    capabilities: ["tools", "reasoning"],
    contextLength: 262144,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: ["off", "on"],
    defaultReasoning: "off",
    quantization: "8bit",
    arch: "qwen3",
  },
  {
    sourceId: "lmstudio",
    modelId: "lmstudio-community/qwen3.6-27b-mlx",
    displayName: "lmstudio-community/qwen3.6-27b-mlx",
    kind: "local",
    capabilities: ["tools", "reasoning"],
    contextLength: 65536,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: ["off", "on"],
    defaultReasoning: "off",
    quantization: "4bit",
    arch: "qwen3",
  },
  {
    sourceId: "lmstudio",
    modelId: "qwen/qwen3-vl-8b",
    displayName: "qwen/qwen3-vl-8b",
    kind: "local",
    capabilities: ["vision", "reasoning"],
    contextLength: 128000,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: ["off", "on"],
    defaultReasoning: "off",
    quantization: "4bit",
    arch: "qwen3-vl",
  },
];
