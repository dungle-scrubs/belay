import { generationResourceKey } from "../admission/contract";
import { ADMISSION_STALE_MS, type AdmissionCaps, liveActiveRecords } from "../admission/store";
import type { LocalResidencyClaims, ResidencyClaimTarget } from "./claims";
import type { LocalResidencyRegistry } from "./registry";

/**
 * Reference-counted eviction of Belay-loaded local models (plan 11.1 M4).
 *
 * A model Belay loaded is unloaded ONLY when it is orphaned - no live instance still claims it (M3) AND
 * no active generation lease references it (plan 11 M6) - and the unload runs under plan 11's per-endpoint
 * LIFECYCLE lease so it can never race a concurrent reload or another sweep (D-002). Only models THIS
 * instance loaded are eviction-eligible (D-004): a manually-loaded or another-app model is never in the
 * registry and never touched. The sweep is idempotent - the gates are re-checked inside the lease, so two
 * concurrent sweeps cannot double-unload and a claim/generation arriving mid-sweep cancels the unload.
 *
 * Responsible for: the eviction sweep - unloading orphaned Belay-loaded models under the lease.
 * Not for: choosing which model to keep resident - the policy lives in controller.ts.
 */

/** Why a candidate was not unloaded (skip reason), for events + /doctor. */
export type EvictionSkip = "other-claim" | "active-generation" | "not-belay-loaded";

/** The outcome for one candidate model in a sweep. */
export type EvictionOutcome =
  | { readonly model: string; readonly unloaded: true }
  | { readonly model: string; readonly unloaded: false; readonly skipped: EvictionSkip };

/** The last model this instance actually evicted, for the /doctor residency surface (M6). */
export interface LastEviction {
  readonly endpoint: string;
  readonly model: string;
  /** ISO time of the unload. */
  readonly at: string;
}

export interface EvictionDeps {
  /** The Belay-loaded set (eviction eligibility + the candidate list). */
  readonly registry: LocalResidencyRegistry;
  /** The cross-instance residency reference count. */
  readonly claims: LocalResidencyClaims;
  /** Plan 11's store caps, used to inspect the generation resource for an active stream. */
  readonly caps: AdmissionCaps;
  /** Runs `fn` under plan 11's per-endpoint lifecycle lease (serializes unload vs reload vs sweep). */
  readonly withLifecycleLease: (
    target: ResidencyClaimTarget,
    fn: () => Promise<void>,
  ) => Promise<void>;
  /** Unloads a model from the runtime (`lms unload <model>`). */
  readonly unload: (model: string) => Promise<void>;
  /** Staleness window for counting a live generation holder (defaults to plan 11's). */
  readonly staleAfterMs?: number;
}

export class LocalResidencyEviction {
  /** The most recent model this instance unloaded, surfaced by /doctor (M6). */
  private last: LastEviction | null = null;

  constructor(private readonly deps: EvictionDeps) {}

  /** The last eviction this instance performed, or null if it has evicted nothing. */
  lastEviction(): LastEviction | null {
    return this.last;
  }

  /** True when a live generation stream currently holds the model's generation resource (plan 11 M6). */
  private hasActiveGeneration(target: ResidencyClaimTarget): boolean {
    const stale = this.deps.staleAfterMs ?? ADMISSION_STALE_MS;
    const key = generationResourceKey(target.provider, target.baseUrl, target.model);
    return liveActiveRecords(key, this.deps.caps, stale).length > 0;
  }

  /** Whether `target` is currently evictable: Belay-loaded, no live claim, no active generation. Returns
   *  the blocking skip reason otherwise. Pure read (no lease, no unload). */
  private blockedReason(target: ResidencyClaimTarget): EvictionSkip | null {
    if (!this.deps.registry.isTrevorLoaded(target.baseUrl, target.model)) {
      return "not-belay-loaded";
    }
    if (this.deps.claims.liveClaims(target) > 0) {
      return "other-claim";
    }
    if (this.hasActiveGeneration(target)) {
      return "active-generation";
    }
    return null;
  }

  /**
   * Sweeps every Belay-loaded model on `endpoint` and unloads each orphaned one under the lifecycle
   * lease. `provider` is the local provider id (e.g. "lmstudio"). Returns the per-model outcomes.
   */
  async sweep(provider: string, endpoint: string): Promise<readonly EvictionOutcome[]> {
    const outcomes: EvictionOutcome[] = [];
    const candidates = this.deps.registry.resident().filter((m) => m.endpoint === endpoint);
    for (const candidate of candidates) {
      const target: ResidencyClaimTarget = { provider, baseUrl: endpoint, model: candidate.model };
      const blocked = this.blockedReason(target);
      if (blocked) {
        outcomes.push({ model: candidate.model, unloaded: false, skipped: blocked });
        continue;
      }
      // Decide inside the lease and CAPTURE the outcome there, so the skip reason isn't recomputed (a
      // third store read) and can't disagree with what the under-lease re-check actually saw.
      let outcome: EvictionOutcome | undefined;
      await this.deps.withLifecycleLease(target, async () => {
        // Re-check under the lease: a claim or a generation may have arrived since the pre-check, and a
        // concurrent sweep may already have unloaded this model (registry no longer Belay-loaded).
        const reblocked = this.blockedReason(target);
        if (reblocked) {
          outcome = { model: candidate.model, unloaded: false, skipped: reblocked };
          return;
        }
        await this.deps.unload(candidate.model);
        this.deps.registry.recordUnload(endpoint, candidate.model);
        this.last = {
          endpoint,
          model: candidate.model,
          at: new Date(this.deps.caps.now()).toISOString(),
        };
        outcome = { model: candidate.model, unloaded: true };
      });
      outcomes.push(outcome ?? { model: candidate.model, unloaded: false, skipped: "other-claim" });
    }
    return outcomes;
  }
}
