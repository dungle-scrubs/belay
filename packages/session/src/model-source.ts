import { asNumber, asRecord, asString, asStringArray, oneOf, oneOfOrNull } from "./coerce";
import type { ProviderModel } from "./protocol";

/**
 * Model-source + catalog domain contract (D-065 M1).
 *
 * A MODEL SOURCE is the product unit ABOVE a provider adapter: the thing a user picks a model FROM -
 * a local runtime (LM Studio, Ollama), an OAuth subscription (a logged-in plan), a gateway catalog
 * (an aggregator), or a direct API-key provider. The host owns source status, auth state, and
 * catalog freshness; the browser renders these read models and never hardcodes a model list. A model
 * is referenced stably by `{ sourceId, modelId }` plus the selected reasoning, so renaming a
 * provider's display label never breaks a saved selection.
 *
 * This module is the shared vocabulary only - types, tolerant decoders for the wire read models, a
 * source-state projection helper, and a backward-compat bridge from the legacy `provider` string +
 * {@link ProviderModel} so the migration runs with both contracts live. Nothing here renders or
 * probes; the host builds the read models, the chooser UI renders them (mirrors `doctor.ts`).
 */

/** Default OpenAI-compatible LM Studio endpoint when `LMSTUDIO_URL` is not set. */
export const DEFAULT_LMSTUDIO_URL = "http://localhost:1234/v1";

/** The four source families a model can come from. */
export type SourceType = "local" | "oauth" | "gateway" | "api-key";

/** Operational status of a source (host-owned). */
export type SourceStatus = "ready" | "needs-auth" | "unavailable" | "error";

/** Auth state of a source (host-owned). */
export type SourceAuthState = "none" | "pending" | "authenticated" | "expired";

/** Where a model runs. */
export type ModelKind = "local" | "cloud";

/** A coarse cost tier, when the source reports one. */
export type CostTier = "free" | "low" | "medium" | "high";

/** An action the chooser may offer for a source (host-owned; the UI renders, never invents). */
export type SourceAction = "authenticate" | "reauthenticate" | "refresh" | "configure" | "disable";

/**
 * A stable model reference: `{ sourceId, modelId }` plus the selected reasoning. Stable across
 * display-label renames, so a saved selection keeps resolving to the same model. `reasoning` is the
 * provider-defined level the user picked, or null when defaulted/none.
 */
export interface ModelRef {
  readonly sourceId: string;
  readonly modelId: string;
  readonly reasoning: string | null;
}

/**
 * Catalog freshness: when the source's catalog was last refreshed and whether it is now stale. The
 * host decides staleness (it knows each source's refresh cadence); the UI only displays it.
 */
export interface CatalogFreshness {
  /** ISO timestamp of the last successful catalog refresh, or null when never refreshed. */
  readonly refreshedAt: string | null;
  readonly stale: boolean;
}

/**
 * A source summary read model: enough to render a source row and decide selectability WITHOUT its
 * full catalog (status, model count, auth state, catalog freshness, available actions).
 */
export interface SourceSummary {
  readonly sourceId: string;
  readonly type: SourceType;
  readonly label: string;
  readonly status: SourceStatus;
  readonly modelCount: number;
  readonly auth: SourceAuthState;
  readonly freshness: CatalogFreshness;
  readonly actions: readonly SourceAction[];
}

/**
 * One catalog entry: a concrete model a source offers, with display name, kind, capabilities,
 * context length, cost tier (when known), aliases, and freshness. `contextLength`/`costTier` are
 * null when the source does not report them.
 */
export interface CatalogEntry {
  readonly sourceId: string;
  readonly modelId: string;
  readonly displayName: string;
  readonly kind: ModelKind;
  readonly capabilities: readonly string[];
  readonly contextLength: number | null;
  readonly costTier: CostTier | null;
  readonly aliases: readonly string[];
  readonly freshness: CatalogFreshness;
  /** The model's detected reasoning levels (lowest→highest), so the chooser shows the right control
   *  for the selected model. Empty when the model has no thinking surface. */
  readonly reasoningLevels: readonly string[];
  /** The reasoning level to default to within {@link reasoningLevels}; "off" when there is none. */
  readonly defaultReasoning: string;
  /** LM Studio quantization label (LOCAL source only), e.g. "8bit"/"4bit" - the differentiator that
   *  tells two same-id quants apart in the chooser. Absent for cloud entries and for a local model
   *  whose native `/api/v0` record was unavailable (the id-only degraded shape). */
  readonly quantization?: string;
  /** Model architecture family (LOCAL source only), e.g. "qwen3". Absent for cloud entries. */
  readonly arch?: string;
}

/** The catalog entry for a model reference within a per-source catalog map (`catalogBySource`), or
 *  undefined when the source or model is not listed. Shared by the host (switch context-window lookup)
 *  and the web (send-time model metadata) so the `bySource[sourceId]?.find(modelId)` shape lives once. */
export function catalogEntryFor(
  bySource: Readonly<Record<string, readonly CatalogEntry[]>>,
  ref: Pick<ModelRef, "sourceId" | "modelId">,
): CatalogEntry | undefined {
  return bySource[ref.sourceId]?.find((entry) => entry.modelId === ref.modelId);
}

const SOURCE_TYPES: readonly SourceType[] = ["local", "oauth", "gateway", "api-key"];
const SOURCE_STATUSES: readonly SourceStatus[] = ["ready", "needs-auth", "unavailable", "error"];
const AUTH_STATES: readonly SourceAuthState[] = ["none", "pending", "authenticated", "expired"];
const COST_TIERS: readonly CostTier[] = ["free", "low", "medium", "high"];
const SOURCE_ACTIONS: readonly SourceAction[] = [
  "authenticate",
  "reauthenticate",
  "refresh",
  "configure",
  "disable",
];

/** Decodes an unknown to a {@link SourceType}, falling back to `"api-key"` for anything unrecognised. */
export function decodeSourceType(v: unknown): SourceType {
  return oneOf(SOURCE_TYPES, v, "api-key");
}

/** Decodes catalog freshness; a missing/garbled value reads as never-refreshed and stale. */
export function decodeFreshness(v: unknown): CatalogFreshness {
  const r = asRecord(v);
  return {
    refreshedAt: typeof r.refreshedAt === "string" ? r.refreshedAt : null,
    stale: typeof r.stale === "boolean" ? r.stale : r.refreshedAt == null,
  };
}

/** Decodes a source summary from wire JSON, defaulting every field so a partial row never throws. */
export function decodeSourceSummary(v: unknown): SourceSummary {
  const r = asRecord(v);
  const actions = asStringArray(r.actions).filter((a): a is SourceAction =>
    (SOURCE_ACTIONS as readonly string[]).includes(a),
  );
  return {
    sourceId: asString(r.sourceId),
    type: decodeSourceType(r.type),
    label: asString(r.label, asString(r.sourceId)),
    status: oneOf(SOURCE_STATUSES, r.status, "unavailable"),
    modelCount: Math.max(0, Math.floor(asNumber(r.modelCount, 0))),
    auth: oneOf(AUTH_STATES, r.auth, "none"),
    freshness: decodeFreshness(r.freshness),
    actions,
  };
}

/** Decodes a catalog entry from wire JSON, defaulting unknown context length / cost tier to null. */
export function decodeCatalogEntry(v: unknown): CatalogEntry {
  const r = asRecord(v);
  const ctx = r.contextLength;
  return {
    sourceId: asString(r.sourceId),
    modelId: asString(r.modelId),
    displayName: asString(r.displayName, asString(r.modelId)),
    kind: oneOf(["local", "cloud"] as const, r.kind, "cloud"),
    capabilities: asStringArray(r.capabilities),
    contextLength:
      typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : null,
    costTier: typeof r.costTier === "string" ? oneOfOrNull(COST_TIERS, r.costTier) : null,
    aliases: asStringArray(r.aliases),
    freshness: decodeFreshness(r.freshness),
    reasoningLevels: asStringArray(r.reasoningLevels),
    defaultReasoning: typeof r.defaultReasoning === "string" ? r.defaultReasoning : "off",
    // Optional local-only fields: kept absent (not null) when missing so the entry round-trips and
    // cloud entries stay free of them.
    ...(typeof r.quantization === "string" && r.quantization
      ? { quantization: r.quantization }
      : {}),
    ...(typeof r.arch === "string" && r.arch ? { arch: r.arch } : {}),
  };
}

/** The phases of a host-driven source sign-in flow (D-065 M5). The host emits these as it runs an
 *  OAuth/device-code login; `device-code` carries the URL + short user code to authorize. */
export const SOURCE_SIGNIN_PHASES = ["device-code", "complete", "error", "cancelled"] as const;
export type SourceSignInPhase = (typeof SOURCE_SIGNIN_PHASES)[number];

/** A snapshot of a source's in-flight sign-in flow (D-065 M5). Carries NO API key - only the
 *  device-code link + short user code (a verification code, never a secret) + a sanitized detail. */
export interface SourceSignInState {
  readonly sourceId: string;
  readonly phase: SourceSignInPhase;
  /** Device-code phase: the URL the user opens to authorize. */
  readonly verificationUri?: string;
  /** Device-code phase: the short user code to enter at that URL (NOT an API key). */
  readonly userCode?: string;
  /** Device-code phase: true when the user pastes a code BACK after authorizing (Anthropic's flow:
   *  open the URL, copy the returned code, paste it here). A device-code flow (Codex) leaves it off. */
  readonly acceptsCode?: boolean;
  /** Error phase: a sanitized one-line failure detail. */
  readonly detail?: string;
}

/** Decodes a source sign-in state from wire JSON; a garbled value reads as a cancelled flow. */
export function decodeSourceSignIn(v: unknown): SourceSignInState {
  const r = asRecord(v);
  return {
    sourceId: asString(r.sourceId),
    phase: oneOf(SOURCE_SIGNIN_PHASES, r.phase, "cancelled"),
    ...(typeof r.verificationUri === "string" ? { verificationUri: r.verificationUri } : {}),
    ...(typeof r.userCode === "string" ? { userCode: r.userCode } : {}),
    ...(r.acceptsCode === true ? { acceptsCode: true } : {}),
    ...(typeof r.detail === "string" ? { detail: r.detail } : {}),
  };
}

/** The derived UI state of a source: can a model be picked now, and does it need the user's action. */
export interface SourceState {
  readonly selectable: boolean;
  readonly needsAttention: boolean;
  /** A one-line human status for the source row. */
  readonly summary: string;
}

/**
 * Projects a {@link SourceSummary} into its chooser-facing state. A source is selectable only when it
 * is `ready` AND has at least one model; it needs attention when auth is missing/expired or the
 * status is `needs-auth`/`error`. Pure, so the rules are unit-tested.
 */
export function projectSourceState(s: SourceSummary): SourceState {
  const authBlocked = s.auth === "none" || s.auth === "expired" || s.status === "needs-auth";
  const errored = s.status === "error";
  const selectable = s.status === "ready" && s.modelCount > 0 && !authBlocked;
  const needsAttention = authBlocked || errored;
  const summary = errored
    ? "error - check the source"
    : authBlocked
      ? s.auth === "expired"
        ? "sign-in expired"
        : "sign-in required"
      : s.status === "unavailable"
        ? "unavailable"
        : s.modelCount === 0
          ? "no models"
          : s.freshness.stale
            ? `${s.modelCount} models (catalog stale)`
            : `${s.modelCount} models`;
  return { selectable, needsAttention, summary };
}

/**
 * Backward-compat bridge (migration): the legacy `provider` string IS the source id, so a current
 * selection maps to a stable {@link ModelRef} with both contracts live. `reasoning` defaults to null.
 */
export function modelRefFromProvider(
  provider: string,
  modelId: string,
  reasoning: string | null = null,
): ModelRef {
  return { sourceId: provider, modelId, reasoning };
}

/** The inverse bridge: the legacy `provider` string a {@link ModelRef} maps back to (its sourceId). */
export function providerStringOf(ref: ModelRef): string {
  return ref.sourceId;
}

/**
 * Tolerantly decodes a {@link ModelRef} from wire/persisted JSON, or null when the shape is unusable
 * (no source/model id). The single decode for a model reference - the protocol's `user.message.model`
 * field and the persisted preferences both route through it - so a partial or garbled ref loads to
 * null instead of throwing. `reasoning` decodes to null when absent (the provider default).
 */
export function decodeModelRef(v: unknown): ModelRef | null {
  const r = asRecord(v);
  if (typeof r.sourceId !== "string" || typeof r.modelId !== "string") {
    return null;
  }
  return {
    sourceId: r.sourceId,
    modelId: r.modelId,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : null,
  };
}

/**
 * Resolves a user turn's provider source + reasoning during the migration: a present {@link ModelRef}
 * (the new contract) WINS - its `sourceId` is the provider key and its `reasoning` is authoritative
 * (null = the provider default) - otherwise the legacy `provider` / `reasoning` strings. So an old
 * event keeps resolving and a new event drives selection through one path. The host feeds `sourceId`
 * to `pickProvider` (which defaults an unknown/undefined key) and `reasoning` to the turn.
 */
export function resolveUserTurnModel(msg: {
  readonly model?: ModelRef;
  readonly provider?: string;
  readonly reasoning?: string;
}): { readonly sourceId: string | undefined; readonly reasoning: string | undefined } {
  if (msg.model) {
    return { sourceId: msg.model.sourceId, reasoning: msg.model.reasoning ?? undefined };
  }
  return { sourceId: msg.provider, reasoning: msg.reasoning };
}

/**
 * Projects a legacy {@link ProviderModel} (announced under a `provider` string) into a
 * {@link CatalogEntry}, so the old host.online model list renders through the new catalog contract
 * during migration. Freshness is unknown for a legacy projection (never-refreshed, not stale).
 */
export function catalogEntryFromProviderModel(provider: string, pm: ProviderModel): CatalogEntry {
  return {
    sourceId: provider,
    modelId: pm.model,
    displayName: pm.label,
    kind: pm.kind,
    capabilities: pm.reasoningLevels.length > 1 ? ["reasoning"] : [],
    contextLength: null,
    costTier: null,
    aliases: [],
    freshness: { refreshedAt: null, stale: false },
    reasoningLevels: pm.reasoningLevels,
    defaultReasoning: pm.defaultReasoning,
  };
}

export type { CatalogFilters, CatalogPage, CatalogQuery } from "./catalog-query";
export {
  CATALOG_PAGE_DEFAULT,
  CATALOG_PAGE_MAX,
  filterCatalog,
  queryCatalog,
} from "./catalog-query";
