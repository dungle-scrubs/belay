import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { SourceType } from "@trevor/session";
import { DEFAULT_LMSTUDIO_URL } from "@trevor/session";
import { debug } from "../log";
import { msg } from "../messages";
import { type LmStudioModelRecord, parseLmStudioModelList } from "./lmstudio-native";

/** The LM Studio OpenAI-compatible base URL, read at CALL time (not a module constant) so
 *  `/catalog-refresh` and tests can retarget it via `LMSTUDIO_URL` without a host restart. */
function lmStudioBaseUrl(): string {
  return process.env.LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL;
}

export interface SourceModelDef {
  readonly type: SourceType;
  readonly piProvider?: string;
  readonly baseUrl?: string;
}

export interface LiveModel {
  readonly id: string;
  readonly name?: string;
  /** The LM Studio native `/api/v0` record for a LOCAL model (quantization, type, arch, context,
   *  capabilities); absent for cloud sources and for a local model when `/api/v0` was unreachable. */
  readonly native?: LmStudioModelRecord;
}

export function asLiveModel(model: string | LiveModel): LiveModel {
  return typeof model === "string" ? { id: model } : model;
}

/** The OpenAI-compatible base URL for a CLOUD source (gateway/api-key/oauth): an explicit override, the
 *  pi-ai registry's URL, or null. Local sources resolve their URL via {@link lmStudioBaseUrl} instead. */
function cloudBaseUrlOf(source: SourceModelDef): string | null {
  if (source.baseUrl) {
    return source.baseUrl;
  }
  if (!source.piProvider) {
    return null;
  }
  const model = (
    getBuiltinModels(source.piProvider as "deepseek") as Array<{ baseUrl?: string }>
  )[0];
  return typeof model?.baseUrl === "string" ? model.baseUrl : null;
}

/** The OpenAI-compatible `/v1/models` id+name list every source can speak (the only shape a cloud
 *  source exposes, and the local id-only fallback when `/api/v0` is down). */
async function fetchLiveModels(baseUrl: string, key: string | null): Promise<LiveModel[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`models query failed (${res.status})`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
  return (json.data ?? [])
    .filter((m): m is { id: string; name?: unknown } => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name ? m.name : undefined }));
}

/**
 * The local (LM Studio) catalog fetch: read the NATIVE `/api/v0/models` so each model carries its
 * quantization / type / arch / context / capabilities (D-001).
 *
 * The native endpoint can fail two ways, and they degrade differently (D-006):
 * - REACHABLE but non-OK (an older LM Studio without `/api/v0`): the id-only `/v1/models` list IS
 *   worth trying against the same reachable host, so the models still list (marked stale).
 * - UNREACHABLE (connection refused / timeout - the common "LM Studio not running" case): the
 *   `/v1/models` fallback targets the SAME host:port and is doomed too, so we skip that wasted
 *   round-trip (it would otherwise double the worst-case startup latency) and report empty + stale.
 */
async function fetchLocalSourceModels(): Promise<{ models: LiveModel[]; stale: boolean }> {
  const baseUrl = lmStudioBaseUrl();
  let nativeRes: Response;
  try {
    nativeRes = await fetch(new URL("/api/v0/models", baseUrl), {
      signal: AbortSignal.timeout(8000),
    });
  } catch (cause) {
    debug("catalog", "local catalog: LM Studio unreachable, no fallback", { reason: msg(cause) });
    return { models: [], stale: true };
  }
  if (nativeRes.ok) {
    const models = parseLmStudioModelList(await nativeRes.json()).map((native) => ({
      id: native.id,
      native,
    }));
    debug("catalog", "local catalog via native /api/v0/models", { count: models.length });
    return { models, stale: false };
  }
  // Reachable but the native endpoint is missing/erroring (older LM Studio): fall back to id-only.
  try {
    const models = await fetchLiveModels(baseUrl, null);
    debug("catalog", "local catalog degraded to id-only /v1/models", {
      count: models.length,
      status: nativeRes.status,
    });
    return { models, stale: true };
  } catch {
    return { models: [], stale: true };
  }
}

export async function fetchSourceModels(
  source: SourceModelDef,
  key: string | null,
): Promise<{ models: LiveModel[]; stale: boolean }> {
  // Only the local (LM Studio) source has the native endpoint; cloud/gateway/api-key sources have no
  // such endpoint, so they stay on the OpenAI `/v1/models` + pi-ai enrichment path (D-005).
  if (source.type === "local") {
    return fetchLocalSourceModels();
  }
  const baseUrl = cloudBaseUrlOf(source);
  let models: LiveModel[] = [];
  let stale = false;
  if (baseUrl != null && key !== null) {
    try {
      models = await fetchLiveModels(baseUrl, key);
    } catch {
      stale = true;
    }
  }
  if (models.length === 0 && source.piProvider) {
    models = (
      getBuiltinModels(source.piProvider as "deepseek") as Array<{ id: string; name?: string }>
    ).map((m) => ({ id: m.id, name: m.name }));
  }
  return { models, stale };
}
