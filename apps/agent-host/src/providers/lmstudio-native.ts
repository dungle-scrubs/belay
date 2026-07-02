import { asPositiveInt } from "@host/boot/coerce";

/**
 * The LM Studio native `/api/v0` model-record shape + its tolerant parser - the ONE place `/api/v0`
 * model JSON is decoded, shared by the catalog's local list fetch ({@link ./source-models}) and the
 * per-model load lookup ({@link ./lmstudio-client}). LM Studio's native endpoint carries the metadata
 * the OpenAI-compatible `/v1/models` omits: quantization, model type (vlm/llm), arch, the native max
 * context, and capability flags (e.g. `tool_use`). Cloud sources have no equivalent endpoint, so this
 * is LM-Studio-specific by design (D-001, D-005).
 *
 * It owns parsing + the tiny pure derivations of the native record (is-vision, supports-tools); it does
 * NOT fetch (the two callers own their own HTTP) and it does NOT build a CatalogEntry (the catalog owns
 * the read model). Parse defensively: a shape drift across LM Studio versions degrades field-by-field
 * rather than throwing, so a missing field falls back to the id-only shape instead of dropping a model.
 */

/** One LM Studio model as the native `/api/v0` endpoint reports it (a list item or a single-model lookup). */
export interface LmStudioModelRecord {
  /** The model id (the same key the OpenAI `/v1/models` list uses). Empty when the record omits it. */
  readonly id: string;
  /** "vlm" (vision-language), "llm" (text-only), "embeddings", etc. */
  readonly type?: string;
  /** Feature flags LM Studio reports for the model, e.g. `["tool_use"]`. */
  readonly capabilities?: readonly string[];
  /** Quantization label, e.g. "4bit", "8bit", "Q4_K_M" - the differentiator between two same-id quants. */
  readonly quantization?: string;
  /** Model architecture family, e.g. "qwen3", "llama". */
  readonly arch?: string;
  /** Load state, e.g. "loaded" | "not-loaded". */
  readonly state?: string;
  /** The context the currently-loaded instance serves (tokens); present only while loaded. */
  readonly loadedContextLength?: number;
  /** The model's native maximum context (tokens) - its ceiling regardless of the loaded window. */
  readonly maxContextLength?: number;
}

function asCleanString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Tolerantly decodes one native `/api/v0` model record, keeping only well-formed fields and dropping
 * anything garbled, so a shape drift across LM Studio versions degrades field-by-field instead of
 * throwing. Returns null only when the input is not an object at all.
 */
export function parseLmStudioModel(raw: unknown): LmStudioModelRecord | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const type = asCleanString(r.type);
  const quantization = asCleanString(r.quantization);
  const arch = asCleanString(r.arch);
  const state = asCleanString(r.state);
  const loadedContextLength = asPositiveInt(r.loaded_context_length);
  const maxContextLength = asPositiveInt(r.max_context_length);
  const capabilities = Array.isArray(r.capabilities)
    ? r.capabilities.filter((c): c is string => typeof c === "string")
    : undefined;
  return {
    id: asCleanString(r.id) ?? "",
    ...(type ? { type } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(quantization ? { quantization } : {}),
    ...(arch ? { arch } : {}),
    ...(state ? { state } : {}),
    ...(loadedContextLength !== undefined ? { loadedContextLength } : {}),
    ...(maxContextLength !== undefined ? { maxContextLength } : {}),
  };
}

/**
 * Decodes the native `/api/v0/models` LIST response (`{ data: [...] }`, mirroring the OpenAI list
 * envelope) into clean records, skipping any entry that carries no id. A non-list / garbled payload
 * yields an empty array rather than throwing.
 */
export function parseLmStudioModelList(json: unknown): LmStudioModelRecord[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map(parseLmStudioModel)
    .filter((r): r is LmStudioModelRecord => r !== null && r.id.length > 0);
}

/** True when the native record marks a vision-language model (`type: "vlm"`). */
export function lmStudioIsVision(record: LmStudioModelRecord): boolean {
  return record.type === "vlm";
}

/** True when the native record advertises tool use (`capabilities` includes `tool_use`). */
export function lmStudioSupportsTools(record: LmStudioModelRecord): boolean {
  return record.capabilities?.includes("tool_use") ?? false;
}
