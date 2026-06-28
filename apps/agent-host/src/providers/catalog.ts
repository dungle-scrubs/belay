import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getModel, getModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  CatalogEntry,
  ModelKind,
  SourceStatus,
  SourceSummary,
  SourceType,
} from "@trevor/session";
import { CodexProvider } from "./codex";
import { lmStudioProvider } from "./lmstudio";
import { PiKeyProvider } from "./pi-key";
import type { Provider } from "./types";

/**
 * The host-owned model SOURCE + catalog read model (D-065 M4/M5).
 *
 * A SOURCE is the provider/runtime/subscription a model is picked FROM - a local runtime (LM Studio),
 * an OAuth subscription (OpenAI/ChatGPT), or a direct API-key provider (DeepSeek, Z.ai, MiniMax) - and
 * a configured source exposes its WHOLE model catalog, queried LIVE from the provider's `/models`
 * endpoint with the user's key (NOT pi-ai's bundled static registry, which can be stale). pi-ai's
 * `getModel` is used only to ENRICH a live id with its shape (context window, reasoning, vision); when
 * the live query fails the static registry is the fallback so a source is never empty for no reason.
 *
 * The host is the source of truth for source status + auth state + the catalog; the browser renders
 * these read models and never hardcodes a model list (mirrors the doctor snapshot).
 */

/** A configurable source: the stable id, its type, label, and how to reach + authenticate it. */
interface SourceDef {
  readonly sourceId: string;
  readonly type: SourceType;
  readonly label: string;
  /** pi-ai registry provider id (cloud sources), for the base URL + model-shape enrichment. */
  readonly piProvider?: string;
  /** `~/.pi/auth.json` static-key entry (`{ key }`) for an api-key source. */
  readonly authName?: string;
  /** `~/.pi/auth.json` OAuth entry for an oauth source. */
  readonly oauthName?: string;
}

/** The sources the host knows about (a new provider is one row here). */
const SOURCES: readonly SourceDef[] = [
  { sourceId: "lmstudio", type: "local", label: "LM Studio" },
  {
    sourceId: "openai",
    type: "oauth",
    label: "OpenAI",
    piProvider: "openai",
    oauthName: "openai-codex",
  },
  {
    sourceId: "deepseek",
    type: "api-key",
    label: "DeepSeek",
    piProvider: "deepseek",
    authName: "deepseek",
  },
  { sourceId: "zai", type: "api-key", label: "Z.ai", piProvider: "zai", authName: "zai" },
  {
    sourceId: "minimax",
    type: "api-key",
    label: "MiniMax",
    piProvider: "minimax",
    authName: "minimax",
  },
  // A cloud gateway/proxy: one key fronts hundreds of upstream models (256+ in pi-ai's registry, more
  // live). Its catalog is the large one the chooser virtualizes.
  {
    sourceId: "openrouter",
    type: "gateway",
    label: "OpenRouter",
    piProvider: "openrouter",
    authName: "openrouter",
  },
];

const AUTH_PATH = `${homedir()}/.pi/auth.json`;
const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? "http://localhost:1234/v1";

/** The result of a catalog load: lightweight source summaries + the per-source model entries. */
export interface CatalogSnapshot {
  readonly sources: readonly SourceSummary[];
  readonly catalogBySource: Readonly<Record<string, readonly CatalogEntry[]>>;
}

async function readAuthJson(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(AUTH_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Whether a source's credential is present in auth.json (local runtimes are always "configured"). */
function isConfigured(source: SourceDef, auth: Record<string, unknown>): boolean {
  if (source.type === "local") {
    return true;
  }
  if (source.oauthName) {
    return auth[source.oauthName] != null;
  }
  if (source.authName) {
    const entry = auth[source.authName] as { key?: unknown } | undefined;
    return typeof entry?.key === "string" && entry.key.length > 0;
  }
  return false;
}

/** The static-key value for an api-key source, or null. */
function staticKeyOf(source: SourceDef, auth: Record<string, unknown>): string | null {
  if (!source.authName) {
    return null;
  }
  const entry = auth[source.authName] as { key?: unknown } | undefined;
  return typeof entry?.key === "string" && entry.key.length > 0 ? entry.key : null;
}

/** The provider's base URL (from any of its pi-ai registry models), or null when unknown. */
function baseUrlOf(source: SourceDef): string | null {
  if (source.type === "local") {
    return LMSTUDIO_URL;
  }
  if (!source.piProvider) {
    return null;
  }
  const model = (getModels(source.piProvider as "deepseek") as Array<{ baseUrl?: string }>)[0];
  return typeof model?.baseUrl === "string" ? model.baseUrl : null;
}

/** Live OpenAI-compatible `/models` ids from `{baseUrl}/models`, bearer-authed when a key is given. */
async function fetchLiveModelIds(baseUrl: string, key: string | null): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`models query failed (${res.status})`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** The pi-ai registry Model for an id (full object), for shape + reasoning enrichment, or undefined. */
type PiModel = {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly input?: readonly string[];
};
function piModelOf(piProvider: string | undefined, id: string): PiModel | undefined {
  if (!piProvider) {
    return undefined;
  }
  try {
    return getModel(piProvider as "deepseek", id as "deepseek-v4-pro") as PiModel | undefined;
  } catch {
    return undefined;
  }
}

/** The reasoning levels a model supports: a graded/binary surface for a registry model, the LM Studio
 *  on/off toggle for local, or none when the id is unknown to pi-ai. */
function reasoningLevelsFor(source: SourceDef, model: PiModel | undefined): readonly string[] {
  if (source.type === "local") {
    return ["off", "on"];
  }
  if (!model) {
    return [];
  }
  try {
    // getSupportedThinkingLevels reads the model's adapter/reasoning shape (the same call the provider
    // base uses), so the chooser's reasoning control matches what the turn will actually honor.
    return getSupportedThinkingLevels(model as never) as readonly string[];
  } catch {
    return [];
  }
}

/** The default reasoning level within a surface: medium, then high, then off, then the lowest level. */
function defaultReasoningFor(levels: readonly string[]): string {
  if (levels.length === 0) {
    return "off";
  }
  return (
    (levels.includes("medium") && "medium") ||
    (levels.includes("high") && "high") ||
    (levels.includes("off") && "off") ||
    levels[0] ||
    "off"
  );
}

/** LM Studio's /models lists more than chat models (embeddings, rerankers, filters); keep only chat. */
const NON_CHAT_LOCAL =
  /embed|embedding|gliner|rerank|reranker|privacy-filter|whisper|\btts\b|bge-/i;

/** Builds a {@link CatalogEntry} for one model id under a source, enriched from the pi-ai shape. */
function entryFor(source: SourceDef, id: string): CatalogEntry {
  const model = piModelOf(source.piProvider, id);
  const kind: ModelKind = source.type === "local" ? "local" : "cloud";
  const reasoningLevels = reasoningLevelsFor(source, model);
  const capabilities: string[] = ["tools"];
  if (reasoningLevels.length > 1) {
    capabilities.push("reasoning");
  }
  if (model?.input?.includes("image")) {
    capabilities.push("vision");
  }
  return {
    sourceId: source.sourceId,
    modelId: id,
    displayName: model?.name ?? id,
    kind,
    capabilities,
    contextLength: typeof model?.contextWindow === "number" ? model.contextWindow : null,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels,
    defaultReasoning: defaultReasoningFor(reasoningLevels),
  };
}

/** The RAW model ids a source advertises: live `/models`, else pi-ai's registry (no filtering here). */
async function fetchSourceModelIds(source: SourceDef, key: string | null): Promise<string[]> {
  const baseUrl = baseUrlOf(source);
  let ids: string[] = [];
  if (baseUrl) {
    try {
      ids = await fetchLiveModelIds(baseUrl, key);
    } catch {
      // fall through to the static registry
    }
  }
  if (ids.length === 0 && source.piProvider) {
    ids = (getModels(source.piProvider as "deepseek") as Array<{ id: string }>).map((m) => m.id);
  }
  return ids;
}

function statusFor(configured: boolean): SourceStatus {
  return configured ? "ready" : "needs-auth";
}

/**
 * Builds the announced source + catalog snapshot PURELY from the auth (the configured signal - key
 * PRESENCE only, never the value) and the already-fetched per-source model ids. Local non-chat models
 * (embeddings, rerankers) are dropped here; an unconfigured source carries no catalog, just a
 * needs-auth summary. Pure + secret-free by construction (the key never flows into a summary/entry), so
 * the configured projection, summaries, filtering, and redaction are unit-tested without any network.
 */
export function buildCatalogSnapshot(
  auth: Record<string, unknown>,
  idsBySource: Readonly<Record<string, readonly string[]>>,
): CatalogSnapshot {
  const catalogBySource: Record<string, CatalogEntry[]> = {};
  const sources: SourceSummary[] = [];
  for (const source of SOURCES) {
    const configured = isConfigured(source, auth);
    const raw = idsBySource[source.sourceId] ?? [];
    const ids = source.type === "local" ? raw.filter((id) => !NON_CHAT_LOCAL.test(id)) : raw;
    const entries = configured ? ids.map((id) => entryFor(source, id)) : [];
    catalogBySource[source.sourceId] = entries;
    sources.push({
      sourceId: source.sourceId,
      type: source.type,
      label: source.label,
      status: statusFor(configured),
      modelCount: entries.length,
      auth: configured ? "authenticated" : "none",
      freshness: { refreshedAt: null, stale: false },
      actions: configured
        ? ["refresh"]
        : source.type === "oauth"
          ? ["authenticate"]
          : ["configure"],
    });
  }
  return { sources, catalogBySource };
}

/**
 * Builds a {@link Provider} for an arbitrary `{ sourceId, modelId }` selection (D-065 turn resolution),
 * or null when the source is unknown (the caller then falls back to the legacy registered providers).
 * This is what lets ANY model the chooser surfaces actually run: a pi source builds a per-model pi
 * provider (the adapter synthesizes a registry entry for a just-released id), and the local source
 * builds an LM Studio provider for that model id.
 */
export function buildSourceProvider(sourceId: string, modelId: string): Provider | null {
  const source = SOURCES.find((s) => s.sourceId === sourceId);
  if (!source) {
    return null;
  }
  if (source.type === "local") {
    return lmStudioProvider({ model: modelId, label: modelId });
  }
  if (source.type === "oauth") {
    return new CodexProvider({ model: modelId, label: modelId });
  }
  // Direct API-key AND gateway (OpenRouter) sources both stream through a static-key pi provider; the
  // gateway just routes the chosen upstream model id through its single key.
  if (
    (source.type === "api-key" || source.type === "gateway") &&
    source.piProvider &&
    source.authName
  ) {
    return new PiKeyProvider({
      id: source.sourceId,
      piProvider: source.piProvider,
      authName: source.authName,
      model: modelId,
      label: modelId,
    });
  }
  return null;
}

/**
 * Loads the full source + catalog snapshot: which sources exist, whether each is configured, and the
 * live model list per CONFIGURED source (unconfigured sources carry no catalog, just a needs-auth
 * summary so the chooser can offer setup). Best-effort and bounded - a slow/failing source degrades to
 * the static registry or an empty list, never a hang.
 */
export async function loadCatalog(): Promise<CatalogSnapshot> {
  const auth = await readAuthJson();
  // Fetch the raw model ids for each CONFIGURED source (a key/sign-in is present), then build the
  // snapshot purely. Unconfigured sources are skipped (no fetch) and carry a needs-auth summary.
  const idsBySource: Record<string, readonly string[]> = {};
  await Promise.all(
    SOURCES.filter((source) => isConfigured(source, auth)).map(async (source) => {
      idsBySource[source.sourceId] = await fetchSourceModelIds(source, staticKeyOf(source, auth));
    }),
  );
  return buildCatalogSnapshot(auth, idsBySource);
}
