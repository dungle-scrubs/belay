import { randomUUID } from "node:crypto";
import { createLocalAdmissionGate } from "../../src/admission/service";
import { type AdmissionCaps, nodeAdmissionCaps } from "../../src/admission/store";
import type { ResidencyClaimTarget } from "../../src/residency/claims";
import { createHostResidency, type HostResidency } from "../../src/residency/host";

/**
 * A reusable hermetic fake-LM-Studio residency fixture (plan 11.1 M7).
 *
 * Each {@link FakeResidencyInstance} is one "host instance": its own Trevor-loaded registry, admission
 * gate, and a fake `lms unload` that RECORDS the model instead of shelling out - all over ONE shared
 * admission dir on the real filesystem, so two instances reference-count residency claims across a real
 * cross-process store exactly as two OS processes would. No LM Studio, no network: deterministic for the
 * hermetic e2e lane. Reusable by any future local-provider residency test (M7 REFACTOR).
 */

export interface FakeResidencyInstance {
  readonly hostId: string;
  readonly pid: number;
  readonly caps: AdmissionCaps;
  readonly residency: HostResidency;
  /** Models this instance's fake LM Studio has unloaded (the recorded `lms unload` side effect). */
  readonly unloaded: readonly string[];
  /** Simulate this instance running `lms load` for a model: register it Trevor-loaded here. */
  load(target: ResidencyClaimTarget, contextLength?: number): void;
  /** Acquire a real generation lease for `target` (an in-flight stream) on the shared store. */
  startGeneration(target: ResidencyClaimTarget): Promise<{ release: () => Promise<void> }>;
}

export interface FakeLmStudioResidency {
  /** The shared admission dir every instance contends on (remove on teardown). */
  readonly dir: string;
  /** Spin up another instance (its own registry + gate + fake unload) over the shared store. */
  instance(opts?: { readonly hostId?: string; readonly pid?: number }): FakeResidencyInstance;
}

export function makeFakeLmStudioResidency(opts: {
  readonly dir: string;
  readonly staleAfterMs?: number;
}): FakeLmStudioResidency {
  const instance = (io: { readonly hostId?: string; readonly pid?: number } = {}) => {
    const hostId = io.hostId ?? randomUUID();
    const pid = io.pid ?? process.pid;
    const caps = nodeAdmissionCaps({ dir: opts.dir, staleAfterMs: opts.staleAfterMs });
    const gate = createLocalAdmissionGate({ hostId, newOwnerId: () => randomUUID(), caps, pid });
    const unloaded: string[] = [];
    const residency = createHostResidency({
      caps,
      hostId,
      pid,
      withLifecycleLease: (target, fn) => gate.withLifecycle(target, fn),
      unload: async (model) => {
        unloaded.push(model);
      },
      staleAfterMs: opts.staleAfterMs,
    });
    return {
      hostId,
      pid,
      caps,
      residency,
      unloaded,
      load: (target: ResidencyClaimTarget, contextLength = 65_536) =>
        residency.recorder.recordLoad(target.provider, target.baseUrl, target.model, contextLength),
      startGeneration: async (target: ResidencyClaimTarget) => {
        const handle = await gate.acquireGeneration(target);
        return { release: () => handle.release("success") };
      },
    } satisfies FakeResidencyInstance;
  };
  return { dir: opts.dir, instance };
}
