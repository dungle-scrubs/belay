import {
  type CapabilityManifest,
  computeTruncated,
  MANIFEST_VERSION,
  type ManifestHostInfo,
  type ManifestItem,
  type ManifestScope,
  type ManifestSection,
  type ManifestSectionId,
  type ManifestWorkspace,
  orderSections,
  type SectionProvenance,
  type SectionStatus,
} from "./capability-manifest";
import { redactAttributeValue } from "./telemetry-contract";

/**
 * The manifest COMPOSITION engine (plan 14, M2). Each subsystem owns a small {@link SectionProvider} that
 * knows how to summarize itself; a {@link SectionProviderRegistry} collects them by id; {@link buildManifest}
 * runs them all and assembles a {@link CapabilityManifest} in canonical section order.
 *
 * Two invariants make this safe as the substrate for every export:
 *  1. A provider returns only a {@link SectionBody} - the builder stamps `id`/`title` from the registration,
 *     so a provider can never claim another section's id or retitle it.
 *  2. Every provider runs behind a guard: a throw, a rejected promise, or a provider that blows its time
 *     budget becomes an explicit `error` section with a sanitized note - never a thrown export. A single
 *     broken subsystem degrades to one visible error row, it never takes down the whole manifest (the
 *     "missing sections are explicit, not silently omitted" boundary).
 *
 * Pure and browser-safe: it composes provider OUTPUT and never reads a registry itself, so the host-side
 * adapters that DO read registries live in the app, not here.
 */

/** The read-only context a provider sees when asked to summarize itself. */
export interface ManifestBuildContext {
  readonly scope: ManifestScope;
}

/** What a provider returns: a section WITHOUT id/title (the builder stamps those from the registration). */
export interface SectionBody {
  readonly status: SectionStatus;
  readonly items: readonly ManifestItem[];
  readonly note?: string;
  readonly total?: number;
  readonly detail?: string;
  readonly provenance?: SectionProvenance;
}

/** One subsystem's manifest adapter: it owns exactly one section id and knows how to summarize it. */
export interface SectionProvider {
  readonly id: ManifestSectionId;
  readonly title: string;
  /** Summarize this section for `ctx`. May be async; may throw/reject/hang - the builder guards it. */
  provide(ctx: ManifestBuildContext): SectionBody | Promise<SectionBody>;
}

/** A registry of section providers, deduplicated by id and returned in canonical order. */
export interface SectionProviderRegistry {
  /** Registers (or replaces, by id) a provider. */
  register(provider: SectionProvider): void;
  /** All registered providers, in canonical {@link MANIFEST_SECTION_ORDER} - deterministic. */
  providers(): readonly SectionProvider[];
}

export interface ManifestBuildOptions {
  readonly scope: ManifestScope;
  readonly generatedAt: string;
  readonly host?: ManifestHostInfo;
  readonly workspace?: ManifestWorkspace;
  /** Per-provider time budget in ms; a provider slower than this yields an `error` section. Default 2000. */
  readonly providerTimeoutMs?: number;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 2000;
const MAX_NOTE_LENGTH = 200;

export function createSectionProviderRegistry(): SectionProviderRegistry {
  const byId = new Map<ManifestSectionId, SectionProvider>();
  return {
    register(provider) {
      byId.set(provider.id, provider);
    },
    providers() {
      return orderSections([...byId.values()]);
    },
  };
}

/** Caps + secret/path-redacts a provider error note so a failure message can never leak a path or secret. */
function sanitizeNote(message: string): string {
  const redacted = redactAttributeValue(message);
  return redacted.length > MAX_NOTE_LENGTH ? `${redacted.slice(0, MAX_NOTE_LENGTH)}…` : redacted;
}

/** Resolves `run()` or rejects if it has not settled within `ms`. The timer is unref'd so a hung provider
 *  never keeps the process alive, and cleared on the winning path so nothing leaks. */
function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("provider timed out"));
      }
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    run().then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      },
    );
  });
}

/** Runs one provider behind the guard, returning its section or an explicit sanitized `error` section. */
async function runProvider(
  provider: SectionProvider,
  ctx: ManifestBuildContext,
  timeoutMs: number,
): Promise<ManifestSection> {
  try {
    const body = await withTimeout(() => Promise.resolve(provider.provide(ctx)), timeoutMs);
    // Stamp id/title AFTER the spread so a provider that returns an object carrying its own id/title
    // (a whole ManifestSection is structurally a SectionBody) can never claim another id or retitle.
    return { ...body, id: provider.id, title: provider.title };
  } catch (error) {
    return {
      id: provider.id,
      title: provider.title,
      status: "error",
      items: [],
      note: sanitizeNote(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Runs every provider (guarded + concurrently), composes the results into a {@link CapabilityManifest} in
 * canonical section order, and computes the top-level `truncated` flag. Never rejects: a provider fault is
 * captured as an `error` section, so an export built on this always succeeds with an explicit shape.
 */
export async function buildManifest(
  providers: readonly SectionProvider[],
  options: ManifestBuildOptions,
): Promise<CapabilityManifest> {
  const ctx: ManifestBuildContext = { scope: options.scope };
  const timeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const composed = await Promise.all(providers.map((p) => runProvider(p, ctx, timeoutMs)));
  const sections = orderSections(composed);
  return {
    version: MANIFEST_VERSION,
    scope: options.scope,
    generatedAt: options.generatedAt,
    sections,
    truncated: computeTruncated(sections),
    ...(options.host ? { host: options.host } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  };
}
