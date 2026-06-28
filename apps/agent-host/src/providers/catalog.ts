import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { getModel, getModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  CatalogEntry,
  CatalogFreshness,
  ModelKind,
  SourceStatus,
  SourceSummary,
  SourceType,
} from "@trevor/session";
import { AnthropicProvider } from "./anthropic";
import { CodexProvider } from "./codex";
import { lmStudioProvider } from "./lmstudio";
import { OpenAICompatProvider } from "./openai-compat";
import { PI_KEY_PROVIDERS, PiKeyProvider } from "./pi-key";
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
  /** A fixed OpenAI-compatible base URL for a source NOT in pi-ai's registry (e.g. Ollama Cloud);
   *  overrides the registry-derived URL and is what `/models` is queried against. */
  readonly baseUrl?: string;
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
    sourceId: "anthropic",
    type: "oauth",
    label: "Anthropic (Claude)",
    piProvider: "anthropic",
    oauthName: "anthropic",
  },
  // The static-key cloud sources (DeepSeek, Z.ai, MiniMax) are derived from the shared pi-key
  // registry: for these, the source id == the pi-ai provider id == the auth.json entry, so one
  // registry row owns all three. Adding a pi-key provider updates the registry, not this list.
  ...PI_KEY_PROVIDERS.map(
    (def): SourceDef => ({
      sourceId: def.piProvider,
      type: "api-key",
      label: def.sourceLabel,
      piProvider: def.piProvider,
      authName: def.piProvider,
    }),
  ),
  // A cloud gateway/proxy: one key fronts hundreds of upstream models (256+ in pi-ai's registry, more
  // live). Its catalog is the large one the chooser virtualizes.
  {
    sourceId: "openrouter",
    type: "gateway",
    label: "OpenRouter",
    piProvider: "openrouter",
    authName: "openrouter",
  },
  // Ollama Cloud: an OpenAI-compatible gateway that runs hosted models behind one key. pi-ai has NO
  // `ollama` provider, so there's no piProvider - the live `/models` query and the per-model provider
  // both work off the fixed base URL (https://ollama.com/v1) instead of the registry.
  {
    sourceId: "ollama",
    type: "gateway",
    label: "Ollama Cloud",
    authName: "ollama",
    baseUrl: "https://ollama.com/v1",
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

/** The provider's base URL: the fixed one (registry-less endpoints), LM Studio's local URL, else
 *  derived from any of the source's pi-ai registry models. Null when unknown. */
function baseUrlOf(source: SourceDef): string | null {
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

/** One model a source advertises: its id plus an optional provider-supplied display name. */
export interface LiveModel {
  readonly id: string;
  /** The provider's own display name (e.g. OpenRouter's "Anthropic: Claude Opus 4.8"), when given. */
  readonly name?: string;
}

/** Normalizes a raw id or a {@link LiveModel} into a LiveModel (so callers can pass plain ids). */
function asLiveModel(model: string | LiveModel): LiveModel {
  return typeof model === "string" ? { id: model } : model;
}

/** Live OpenAI-compatible models from `{baseUrl}/models` (id + display name), bearer-authed when a
 *  key is given. The `name` field is what gives ids pi-ai doesn't know a real label, not a bare id. */
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

/** Builds a {@link CatalogEntry} for one source model, enriched from the pi-ai shape. The display
 *  name prefers pi-ai's curated name, then the provider's live name, then the raw id - so a model
 *  pi-ai has never heard of still shows the provider's label instead of a bare id. The source's
 *  freshness (stale when its live /models fetch failed) is carried onto each entry. */
function entryFor(source: SourceDef, live: LiveModel, freshness: CatalogFreshness): CatalogEntry {
  const model = piModelOf(source.piProvider, live.id);
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
    modelId: live.id,
    displayName: model?.name ?? live.name ?? live.id,
    kind,
    capabilities,
    contextLength: typeof model?.contextWindow === "number" ? model.contextWindow : null,
    costTier: null,
    aliases: [],
    freshness,
    reasoningLevels,
    defaultReasoning: defaultReasoningFor(reasoningLevels),
  };
}

/** The RAW models a source advertises plus whether the catalog is STALE: a live `/models` query that
 *  was attempted and FAILED falls back to pi-ai's registry (or empty) but flags `stale`, so the chooser
 *  can show "(catalog stale)" + a refresh action instead of silently presenting old/missing data. */
async function fetchSourceModels(
  source: SourceDef,
  key: string | null,
): Promise<{ models: LiveModel[]; stale: boolean }> {
  const baseUrl = baseUrlOf(source);
  let models: LiveModel[] = [];
  let stale = false;
  // A live /models query needs auth: attempt it only when there's a key (api-key/gateway) or it's a
  // local runtime (LM Studio needs none). An OAuth source has no static key here, so it uses the
  // static registry WITHOUT a (misleading) stale flag - its token is resolved per-turn, not for listing.
  if (baseUrl != null && (key !== null || source.type === "local")) {
    try {
      models = await fetchLiveModels(baseUrl, key);
    } catch {
      // The live query failed: fall back to the static registry below, but mark the catalog stale.
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

function statusFor(configured: boolean): SourceStatus {
  return configured ? "ready" : "needs-auth";
}

/**
 * Builds the announced source + catalog snapshot PURELY from the auth (the configured signal - key
 * PRESENCE only, never the value) and the already-fetched per-source models (id + optional name; a
 * plain id is accepted and normalized, so tests can pass bare ids). Local non-chat models
 * (embeddings, rerankers) are dropped here; an unconfigured source carries no catalog, just a
 * needs-auth summary. Pure + secret-free by construction (the key never flows into a summary/entry), so
 * the configured projection, summaries, filtering, and redaction are unit-tested without any network.
 */
export function buildCatalogSnapshot(
  auth: Record<string, unknown>,
  modelsBySource: Readonly<Record<string, readonly (string | LiveModel)[]>>,
  staleSources: ReadonlySet<string> = new Set(),
): CatalogSnapshot {
  const catalogBySource: Record<string, CatalogEntry[]> = {};
  const sources: SourceSummary[] = [];
  for (const source of SOURCES) {
    const configured = isConfigured(source, auth);
    // Stale only applies to a configured source whose live /models query failed (an unconfigured
    // source has no catalog to be stale).
    const freshness: CatalogFreshness = {
      refreshedAt: null,
      stale: configured && staleSources.has(source.sourceId),
    };
    const raw = (modelsBySource[source.sourceId] ?? []).map(asLiveModel);
    const models = source.type === "local" ? raw.filter((m) => !NON_CHAT_LOCAL.test(m.id)) : raw;
    const entries = configured ? models.map((m) => entryFor(source, m, freshness)) : [];
    catalogBySource[source.sourceId] = entries;
    sources.push({
      sourceId: source.sourceId,
      type: source.type,
      label: source.label,
      status: statusFor(configured),
      modelCount: entries.length,
      auth: configured ? "authenticated" : "none",
      freshness,
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
    // Each OAuth subscription has its own provider (different registry + token shape); Codex for
    // OpenAI, Anthropic for Claude Pro/Max.
    return source.sourceId === "anthropic"
      ? new AnthropicProvider({ model: modelId, label: modelId })
      : new CodexProvider({ model: modelId, label: modelId });
  }
  // A gateway/api-key source NOT in pi-ai's registry (Ollama Cloud) streams through its fixed
  // OpenAI-compatible base URL with a static key; the Model is constructed directly (no sibling to
  // clone). This branch comes first because it needs no piProvider.
  if (
    (source.type === "api-key" || source.type === "gateway") &&
    source.baseUrl &&
    source.authName &&
    !source.piProvider
  ) {
    return new OpenAICompatProvider({
      id: source.sourceId,
      authName: source.authName,
      baseUrl: source.baseUrl,
      model: modelId,
      label: modelId,
    });
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
  // Fetch the raw models (id + name) for each CONFIGURED source (a key/sign-in is present), then
  // build the snapshot purely. Unconfigured sources are skipped (no fetch) and carry a needs-auth
  // summary.
  const modelsBySource: Record<string, readonly LiveModel[]> = {};
  const staleSources = new Set<string>();
  await Promise.all(
    SOURCES.filter((source) => isConfigured(source, auth)).map(async (source) => {
      const { models, stale } = await fetchSourceModels(source, staticKeyOf(source, auth));
      modelsBySource[source.sourceId] = models;
      if (stale) {
        staleSources.add(source.sourceId);
      }
    }),
  );
  return buildCatalogSnapshot(auth, modelsBySource, staleSources);
}
