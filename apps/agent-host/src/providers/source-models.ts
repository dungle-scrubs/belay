import { getModels } from "@earendil-works/pi-ai/compat";
import type { SourceType } from "@trevor/session";
import { DEFAULT_LMSTUDIO_URL } from "@trevor/session";

const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? DEFAULT_LMSTUDIO_URL;

export interface SourceModelDef {
  readonly type: SourceType;
  readonly piProvider?: string;
  readonly baseUrl?: string;
}

export interface LiveModel {
  readonly id: string;
  readonly name?: string;
}

export function asLiveModel(model: string | LiveModel): LiveModel {
  return typeof model === "string" ? { id: model } : model;
}

function baseUrlOf(source: SourceModelDef): string | null {
  if (source.type === "local") {
    return LMSTUDIO_URL;
  }
  if (source.baseUrl) {
    return source.baseUrl;
  }
  if (!source.piProvider) {
    return null;
  }
  const model = (getModels(source.piProvider as "deepseek") as Array<{ baseUrl?: string }>)[0];
  return typeof model?.baseUrl === "string" ? model.baseUrl : null;
}

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

export async function fetchSourceModels(
  source: SourceModelDef,
  key: string | null,
): Promise<{ models: LiveModel[]; stale: boolean }> {
  const baseUrl = baseUrlOf(source);
  let models: LiveModel[] = [];
  let stale = false;
  if (baseUrl != null && (key !== null || source.type === "local")) {
    try {
      models = await fetchLiveModels(baseUrl, key);
    } catch {
      stale = true;
    }
  }
  if (models.length === 0 && source.piProvider) {
    models = (
      getModels(source.piProvider as "deepseek") as Array<{ id: string; name?: string }>
    ).map((m) => ({ id: m.id, name: m.name }));
  }
  return { models, stale };
}
