import { type AdmissionOwner, NO_ESTIMATE, normalizeBaseUrl } from "../admission/contract";
import {
  ADMISSION_STALE_MS,
  type AdmissionCaps,
  acquireAdmission,
  heartbeatAdmission,
  inspectResource,
  releaseAdmission,
} from "../admission/store";

/**
 * Cross-instance residency CLAIMS (plan 11.1 M3), layered on plan 11's shared admission store.
 *
 * A Trevor-loaded local model stays resident while ANY live instance claims it; the actual `lms unload`
 * fires only when the LAST claim is released (D-002). Each instance registers ONE claim on the model it
 * currently wants resident (its active local model), and the claim's live COUNT across instances is the
 * reference count the eviction sweep (M4) reads. Claims ride plan 11's lease store, so a crashed
 * instance's claim expires through the SAME TTL + heartbeat + stale-owner reaping (D-007) - no parallel
 * liveness mechanism.
 *
 * A claim is a reference-count REGISTRATION, not a mutex, so the residency resource is given effectively
 * unbounded capacity: every live instance's claim is admitted immediately and none ever queue.
 */

/** The residency resource an instance's active-model claim holds: `local-residency:{providerId}:
 *  {normalizedBaseUrl}:{modelId}` - the lifecycle endpoint plus the model (distinct from the generation
 *  and lifecycle keys, since a claim persists across the instance's active-model lifetime, not one turn). */
export function residencyResourceKey(provider: string, baseUrl: string, model: string): string {
  return `local-residency:${provider}:${normalizeBaseUrl(baseUrl)}:${model}`;
}

/** The concrete local model an instance claims residency on. */
export interface ResidencyClaimTarget {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** Effectively unbounded: a residency claim is a counted registration, so all instances' claims are
 *  admitted at once and never queue. */
const RESIDENCY_CAPACITY = 1_000_000;

export class LocalResidencyClaims {
  constructor(
    private readonly caps: AdmissionCaps,
    /** Builds this instance's STABLE owner record for a target (same ownerId across claim/heartbeat/
     *  release, so they address the one claim). */
    private readonly makeOwner: (target: ResidencyClaimTarget) => AdmissionOwner,
    private readonly staleAfterMs: number = ADMISSION_STALE_MS,
  ) {}

  private key(target: ResidencyClaimTarget): string {
    return residencyResourceKey(target.provider, target.baseUrl, target.model);
  }

  /**
   * Ensures this instance holds a residency claim on `target` (idempotent): heartbeats an existing claim,
   * else registers a new one. Returns the claim's owner id.
   */
  async claim(target: ResidencyClaimTarget): Promise<string> {
    const key = this.key(target);
    const owner = this.makeOwner(target);
    const held = inspectResource(key, this.caps).active.some(
      (a) => a.owner.ownerId === owner.ownerId,
    );
    if (held) {
      await heartbeatAdmission(key, owner.ownerId, this.caps);
    } else {
      await acquireAdmission(
        {
          key,
          owner,
          priority: "maintenance",
          estimate: NO_ESTIMATE,
          capacity: RESIDENCY_CAPACITY,
        },
        this.caps,
      );
    }
    return owner.ownerId;
  }

  /** Releases this instance's claim on `target` (idempotent; a missing claim is a no-op). */
  async release(target: ResidencyClaimTarget): Promise<void> {
    await releaseAdmission(this.key(target), this.makeOwner(target).ownerId, this.caps);
  }

  /** The number of LIVE claims (across instances) on `target` - a dead-pid or heartbeat-aged claim is
   *  excluded, matching what the eviction sweep treats as "still wanted". */
  liveClaims(target: ResidencyClaimTarget): number {
    return inspectResource(this.key(target), this.caps).active.filter(
      (a) => a.alive && a.heartbeatAgeMs <= this.staleAfterMs,
    ).length;
  }

  /** The live claim owners on `target` (for /doctor attribution). */
  claimants(target: ResidencyClaimTarget): readonly AdmissionOwner[] {
    return inspectResource(this.key(target), this.caps)
      .active.filter((a) => a.alive && a.heartbeatAgeMs <= this.staleAfterMs)
      .map((a) => a.owner);
  }
}
