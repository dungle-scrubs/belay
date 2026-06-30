import { readFile } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type {
  CatalogEntry,
  CatalogFreshness,
  SourceStatus,
  SourceSummary,
  SourceType,
} from "@trevor/session";
import { anthropicProvider } from "./anthropic";
import { codexProviderFromConfig } from "./codex";
import { lmStudioProvider } from "./lmstudio";
import { lmStudioIsVision, lmStudioSupportsTools } from "./lmstudio-native";
import { reloadModelOverrides, resolveContextWindow } from "./model-metadata-overrides";
import { openAICompatProvider } from "./openai-compat";
import { PI_KEY_PROVIDERS, piKeyProviderFromConfig } from "./pi-key";
import { lookupPiModel } from "./pi-model";
import { AUTH_PATH, oauthPresent, staticKeyEntry } from "./provider-auth";
import { defaultReasoningLevel } from "./reasoning-policy";
import { asLiveModel, fetchSourceModels, type LiveModel } from "./source-models";
import type { Provider } from "./types";

/**
 * The host-owned model SOURCE + catalog read model (D-065 M4/M5).
 *
 * A SOURCE is the provider/runtime/subscription a model is picked FROM - a local runtime (LM Studio),
 * an OAuth subscription (OpenAI/ChatGPT), or a direct API-key provider (DeepSeek, Z.ai, MiniMax) - and
 * a configured source exposes its WHOLE model catalog, queried LIVE from the provider's `/models`
 * endpoint with the user's key (NOT pi-ai's bundled static registry, which can be stale). pi-ai's
 * `getBuiltinModel` is used only to ENRICH a live id with its shape (context window, reasoning, vision); when
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

/** A source's resolved auth state: whether it's configured + its static key (api-key sources only). */
interface SourceAuth {
  readonly configured: boolean;
  readonly staticKey: string | null;
}

/** A source's static key (api-key sources only; via the shared `{ key }` predicate), or null. */
function staticKeyOf(source: SourceDef, auth: Record<string, unknown>): string | null {
  return source.authName ? staticKeyEntry(auth, source.authName) : null;
}

/** Resolves one source's auth state: local runtimes are always configured; an oauth source needs its
 *  OAuth entry; an api-key source needs a present static key (both via the shared predicates). */
function resolveSourceAuth(source: SourceDef, auth: Record<string, unknown>): SourceAuth {
  if (source.type === "local") {
    return { configured: true, staticKey: null };
  }
  if (source.oauthName) {
    return { configured: oauthPresent(auth, source.oauthName), staticKey: null };
  }
  const staticKey = staticKeyOf(source, auth);
  return { configured: staticKey !== null, staticKey };
}

/** The per-source auth state in ONE pass over SOURCES, so the configured signal + static key are
 *  resolved once and shared by the snapshot builder and the live-models fetch. */
function projectSourceAuth(auth: Record<string, unknown>): Map<string, SourceAuth> {
  return new Map(SOURCES.map((source) => [source.sourceId, resolveSourceAuth(source, auth)]));
}

/** The pi-ai registry Model for an id (full object), for shape + reasoning enrichment, or undefined. */
type PiModel = {
  readonly name?: string;
  readonly contextWindow?: number;
  readonly input?: readonly string[];
};
function piModelOf(piProvider: string | undefined, id: string): PiModel | undefined {
  return piProvider ? (lookupPiModel(piProvider, id) as PiModel | undefined) : undefined;
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

/** LM Studio's /models lists more than chat models (embeddings, rerankers, filters); keep only chat. */
const NON_CHAT_LOCAL =
  /embed|embedding|gliner|rerank|reranker|privacy-filter|whisper|\btts\b|bge-/i;

/** Builds a {@link CatalogEntry} for one source model, dispatching on where the model RUNS: a local
 *  (LM Studio) model derives its capabilities/context from the native `/api/v0` record carried on the
 *  live model, while a cloud model enriches from the pi-ai registry shape. The two paths are kept
 *  separate so neither hardcodes the other's assumptions (D-003). */
function entryFor(source: SourceDef, live: LiveModel, freshness: CatalogFreshness): CatalogEntry {
  const model = piModelOf(source.piProvider, live.id);
  const reasoningLevels = reasoningLevelsFor(source, model);
  return source.type === "local"
    ? localEntry(source, live, freshness, reasoningLevels)
    : cloudEntry(source, live, freshness, model, reasoningLevels);
}

/** A CLOUD catalog entry (D-005, unchanged): capabilities seeded from the always-present tools plus the
 *  pi-ai-derived reasoning surface and `input: ["...","image"]` vision; display name prefers pi-ai's
 *  curated name, then the provider's live name, then the raw id; context is the override-or-bundled
 *  window. */
function cloudEntry(
  source: SourceDef,
  live: LiveModel,
  freshness: CatalogFreshness,
  model: PiModel | undefined,
  reasoningLevels: readonly string[],
): CatalogEntry {
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
    kind: "cloud",
    capabilities,
    // A confirmed override wins over pi-ai's bundled (possibly stale) contextWindow (02.16 D-003).
    contextLength: resolveContextWindow(live.id, model?.contextWindow),
    costTier: null,
    aliases: [],
    freshness,
    reasoningLevels,
    defaultReasoning: defaultReasoningLevel(reasoningLevels),
  };
}

/** A LOCAL (LM Studio) catalog entry: capabilities, vision, context, quantization, and arch come from
 *  the model's native `/api/v0` record (D-003) - tools from the `tool_use` flag (so a non-tool model no
 *  longer falsely shows Tools), vision from `type: "vlm"` (so a local VLM finally gets a Vision tag),
 *  and context from `max_context_length` (still overridable by `models.json` via {@link
 *  resolveContextWindow}). When the native record is absent (`/api/v0` was down) the entry degrades to
 *  the id-only shape: no tools/vision/quant, just the reasoning toggle (D-006). */
function localEntry(
  source: SourceDef,
  live: LiveModel,
  freshness: CatalogFreshness,
  reasoningLevels: readonly string[],
): CatalogEntry {
  const native = live.native;
  const capabilities: string[] = [];
  if (native && lmStudioSupportsTools(native)) {
    capabilities.push("tools");
  }
  if (reasoningLevels.length > 1) {
    capabilities.push("reasoning");
  }
  if (native && lmStudioIsVision(native)) {
    capabilities.push("vision");
  }
  return {
    sourceId: source.sourceId,
    modelId: live.id,
    displayName: live.name ?? live.id,
    kind: "local",
    capabilities,
    // The native max context, with the user's models.json override still winning (override precedence
    // preserved); null when neither is known.
    contextLength: resolveContextWindow(live.id, native?.maxContextLength),
    costTier: null,
    aliases: [],
    freshness,
    reasoningLevels,
    defaultReasoning: defaultReasoningLevel(reasoningLevels),
    ...(native?.quantization ? { quantization: native.quantization } : {}),
    ...(native?.arch ? { arch: native.arch } : {}),
  };
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
  sourceAuth: ReadonlyMap<string, SourceAuth> = projectSourceAuth(auth),
): CatalogSnapshot {
  const catalogBySource: Record<string, CatalogEntry[]> = {};
  const sources: SourceSummary[] = [];
  for (const source of SOURCES) {
    const configured = sourceAuth.get(source.sourceId)?.configured ?? false;
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
 * Builds the concrete {@link Provider} for a source + model id, dispatching on the source's type +
 * auth shape: local -> LM Studio, oauth -> Codex/Anthropic, api-key/gateway -> a static-key pi
 * provider or (when there's a fixed base URL and no pi registry entry) an OpenAI-compatible one.
 * The ONE owner of the adapter-per-source mapping, so catalog turn-resolution can't dispatch a source
 * a different way than anything else that resolves a source. `label` defaults to the model id.
 * Returns null when no adapter matches.
 */
export function providerForSource(
  source: SourceDef,
  modelId: string,
  label: string = modelId,
): Provider | null {
  if (source.type === "local") {
    return lmStudioProvider({ model: modelId, label });
  }
  if (source.type === "oauth") {
    // Each OAuth subscription has its own provider (different registry + token shape); Codex for
    // OpenAI, Anthropic for Claude Pro/Max.
    return source.sourceId === "anthropic"
      ? anthropicProvider({ model: modelId, label })
      : codexProviderFromConfig({ model: modelId, label });
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
    return openAICompatProvider({
      id: source.sourceId,
      authName: source.authName,
      baseUrl: source.baseUrl,
      model: modelId,
      label,
    });
  }
  // Direct API-key AND gateway (OpenRouter) sources both stream through a static-key pi provider; the
  // gateway just routes the chosen upstream model id through its single key.
  if (
    (source.type === "api-key" || source.type === "gateway") &&
    source.piProvider &&
    source.authName
  ) {
    return piKeyProviderFromConfig({
      id: source.sourceId,
      piProvider: source.piProvider,
      authName: source.authName,
      model: modelId,
      label,
    });
  }
  return null;
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
  return source ? providerForSource(source, modelId) : null;
}

/**
 * Loads the full source + catalog snapshot: which sources exist, whether each is configured, and the
 * live model list per CONFIGURED source (unconfigured sources carry no catalog, just a needs-auth
 * summary so the chooser can offer setup). Best-effort and bounded - a slow/failing source degrades to
 * the static registry or an empty list, never a hang.
 */
export async function loadCatalog(): Promise<CatalogSnapshot> {
  // Re-read the user's models.json alongside the provider keys, so editing a window correction and
  // running /catalog-refresh takes effect without a host restart (the resolver is memoized otherwise).
  reloadModelOverrides();
  const auth = await readAuthJson();
  // Resolve each source's auth state ONCE (configured + static key) and reuse it for the fetch filter,
  // the per-source key, and the snapshot - instead of re-parsing the same auth entry at each step.
  const sourceAuth = projectSourceAuth(auth);
  // Fetch the raw models (id + name) for each CONFIGURED source (a key/sign-in is present), then
  // build the snapshot purely. Unconfigured sources are skipped (no fetch) and carry a needs-auth
  // summary.
  const modelsBySource: Record<string, readonly LiveModel[]> = {};
  const staleSources = new Set<string>();
  await Promise.all(
    SOURCES.filter((source) => sourceAuth.get(source.sourceId)?.configured).map(async (source) => {
      const { models, stale } = await fetchSourceModels(
        source,
        sourceAuth.get(source.sourceId)?.staticKey ?? null,
      );
      modelsBySource[source.sourceId] = models;
      if (stale) {
        staleSources.add(source.sourceId);
      }
    }),
  );
  return buildCatalogSnapshot(auth, modelsBySource, staleSources, sourceAuth);
}
