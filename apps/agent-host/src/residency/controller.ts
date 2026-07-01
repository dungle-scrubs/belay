import type { LocalResidencyClaims, ResidencyClaimTarget } from "./claims";
import type { LocalResidencyEviction } from "./eviction";

/**
 * The per-instance residency policy (plan 11.1 M5).
 *
 * Default policy is KEEP-ONLY-CURRENT (cap 1): an instance claims exactly the local model it currently
 * wants resident (its active local model), and on switching it RELEASES the prior claim and claims the
 * new one (D-003). This is a per-instance cap, not a global one - two instances on two different models
 * both keep their models (no thrash); only a model NO live instance claims anymore is reclaimed. After a
 * switch releases the prior claim, a sweep evicts the prior model IFF it is now orphaned (last release),
 * so eviction is reference-counted, never a blind per-switch unload.
 *
 * {@link ResidencyController} is the seam: a keep-N / LRU variant is a different implementation of the
 * same interface, without touching the eviction core.
 */
export interface ResidencyController {
  /** Reconcile claims for this instance's new active local model (or null when it has none). */
  onActiveModelChanged(next: ResidencyClaimTarget | null): Promise<void>;
  /** Refresh the current claim's heartbeat so it does not age out (host timer). No-op when idle. */
  heartbeat(): Promise<void>;
  /** Release the current claim on shutdown and sweep (so a clean stop doesn't pin a model). */
  shutdown(): Promise<void>;
}

function sameTarget(a: ResidencyClaimTarget | null, b: ResidencyClaimTarget | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.provider === b.provider && a.baseUrl === b.baseUrl && a.model === b.model;
}

export class KeepCurrentResidency implements ResidencyController {
  private current: ResidencyClaimTarget | null = null;

  constructor(
    private readonly claims: LocalResidencyClaims,
    private readonly eviction: LocalResidencyEviction,
  ) {}

  async onActiveModelChanged(next: ResidencyClaimTarget | null): Promise<void> {
    if (sameTarget(this.current, next)) {
      // Same model (or still idle): just keep the existing claim fresh.
      if (next) {
        await this.claims.claim(next);
      }
      return;
    }
    const prev = this.current;
    // Claim the NEW model BEFORE releasing/sweeping, so the sweep that follows never evicts it (it is
    // already claimed, and a shared-endpoint sweep considers every Trevor-loaded model there).
    if (next) {
      await this.claims.claim(next);
    }
    if (prev) {
      await this.claims.release(prev);
    }
    this.current = next;
    // The prior model may now be orphaned (this was its last claim) -> sweep its endpoint to
    // evict-on-last-release. A model another live instance still claims is skipped (no thrash).
    if (prev) {
      await this.eviction.sweep(prev.provider, prev.baseUrl);
    }
  }

  async heartbeat(): Promise<void> {
    if (this.current) {
      await this.claims.claim(this.current);
    }
  }

  async shutdown(): Promise<void> {
    const prev = this.current;
    this.current = null;
    if (prev) {
      await this.claims.release(prev);
      await this.eviction.sweep(prev.provider, prev.baseUrl);
    }
  }
}
