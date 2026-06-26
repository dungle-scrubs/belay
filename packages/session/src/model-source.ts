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

const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const asFiniteOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Returns `v` when it is one of `opts`, else `fallback` - the tolerant enum decode. */
function oneOf<T extends string>(opts: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : fallback;
}

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
    modelCount: Math.max(0, Math.floor(asFiniteOr(r.modelCount, 0))),
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
  };
}

/** Like {@link oneOf} but yields null (not a fallback member) for an unrecognised value. */
function oneOfOrNull<T extends string>(opts: readonly T[], v: unknown): T | null {
  return typeof v === "string" && (opts as readonly string[]).includes(v) ? (v as T) : null;
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
  };
}
