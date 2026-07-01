import type { AdmissionOwner } from "../admission/contract";
import type { AdmissionCaps } from "../admission/store";
import { LocalResidencyClaims, type ResidencyClaimTarget } from "./claims";
import { KeepCurrentResidency } from "./controller";
import { type ResidencyDoctorSummary, residencyDoctorSummary } from "./doctor";
import { LocalResidencyEviction } from "./eviction";
import { LocalResidencyRegistry, type ResidencyRecorder } from "./registry";

/**
 * The host-side composition of local-model residency (plan 11.1): it wires the Trevor-loaded registry
 * (M2), the cross-instance claims (M3), the reference-counted eviction (M4), and the keep-current policy
 * (M5) into one object the host drives. `recorder` is handed to the LM Studio provider slots so their
 * loads register here; `onActiveModelChanged` is called when a turn resolves its provider (claim the new
 * local model, release + sweep the prior); `heartbeat` keeps the current claim alive on a host timer;
 * `shutdown` releases + sweeps on a clean stop; `summary` is the /doctor projection (M6).
 */

export interface HostResidencyDeps {
  /** Plan 11's shared-store caps (fs + clock + liveness) the claims + generation inspect run over. */
  readonly caps: AdmissionCaps;
  /** This host instance's id (the residency claim owner). */
  readonly hostId: string;
  /** This host process's pid (liveness for stale-claim reaping). */
  readonly pid: number;
  /** Runs the unload under plan 11's per-endpoint lifecycle lease (usually `gate.withLifecycle`). */
  readonly withLifecycleLease: (
    target: ResidencyClaimTarget,
    fn: () => Promise<void>,
  ) => Promise<void>;
  /** Unloads a model from the local runtime (`lms unload <model>`). */
  readonly unload: (model: string) => Promise<void>;
  /** Claim/generation staleness window (defaults to plan 11's). */
  readonly staleAfterMs?: number;
}

export interface HostResidency {
  /** Passed to each LM Studio slot so its `lms load`/unload registers as Trevor-loaded (M2). */
  readonly recorder: ResidencyRecorder;
  /** Reconcile residency for a turn's resolved provider: `null` for a cloud turn (holds no local model). */
  onActiveModelChanged(target: ResidencyClaimTarget | null): Promise<void>;
  /** Refresh the current claim's heartbeat (host timer) so it does not age out. */
  heartbeat(): Promise<void>;
  /** Release the current claim + sweep on a clean stop, so shutdown never pins a model resident. */
  shutdown(): Promise<void>;
  /** The /doctor residency projection: resident models, caps, live claim counts, last eviction (M6). */
  summary(): ResidencyDoctorSummary;
}

export function createHostResidency(deps: HostResidencyDeps): HostResidency {
  const registry = new LocalResidencyRegistry();
  const owner = (target: ResidencyClaimTarget): AdmissionOwner => ({
    ownerId: deps.hostId,
    hostId: deps.hostId,
    pid: deps.pid,
    provider: target.provider,
    model: target.model,
  });
  const claims = new LocalResidencyClaims(deps.caps, owner, deps.staleAfterMs);
  const eviction = new LocalResidencyEviction({
    registry,
    claims,
    caps: deps.caps,
    withLifecycleLease: deps.withLifecycleLease,
    unload: deps.unload,
    staleAfterMs: deps.staleAfterMs,
  });
  const controller = new KeepCurrentResidency(claims, eviction);
  return {
    recorder: registry,
    onActiveModelChanged: (target) => controller.onActiveModelChanged(target),
    heartbeat: () => controller.heartbeat(),
    shutdown: () => controller.shutdown(),
    summary: () =>
      residencyDoctorSummary(
        registry.resident(),
        (m) => claims.liveClaims({ provider: m.provider, baseUrl: m.endpoint, model: m.model }),
        eviction.lastEviction(),
      ),
  };
}
