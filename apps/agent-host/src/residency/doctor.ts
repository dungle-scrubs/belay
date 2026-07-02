import type { LastEviction } from "./eviction";
import type { ResidentModel } from "./registry";

/**
 * The /doctor projection for local-model residency (plan 11.1 M6): folds the host's Trevor-loaded set
 * (M2) plus its cross-instance claim counts (M3) and last eviction (M4) into the redaction-safe summary
 * the doctor Local-admission area renders alongside admission leases. Pure read model - it never loads,
 * unloads, or claims. Every field is bounded and carries no secret: a model id and an LM Studio endpoint
 * (provider:host:port) are diagnosis handles, never credentials, so they surface as-is (D-004).
 *
 * Responsible for: the /doctor read model: resident models, claim counts, and the last eviction.
 * Not for: the host-wide doctor areas/snapshot - ../doctor/snapshot.ts folds this summary in.
 */

/** One resident model row: where it lives, the context it holds, and how many live instances claim it. */
export interface ResidencyDoctorRow {
  readonly endpoint: string;
  readonly model: string;
  /** The context window (tokens) it was loaded at - its KV-cache footprint driver. */
  readonly contextLength: number;
  /** Live cross-instance residency claims on it (this instance + peers); 0 means orphaned-evictable. */
  readonly claims: number;
}

/** The aggregate residency state /doctor shows for local models this instance loaded. */
export interface ResidencyDoctorSummary {
  readonly residentModels: number;
  readonly rows: readonly ResidencyDoctorRow[];
  /** The last model this instance unloaded, or null if it has evicted nothing this run. */
  readonly lastEviction: LastEviction | null;
}

/**
 * Builds the residency doctor summary from this instance's resident set, a live-claim counter, and the
 * last eviction. `claimsFor` reads the cross-instance claim count for a resident model (M3), kept as an
 * injected reader so this stays a pure fold over already-resolved facts.
 */
export function residencyDoctorSummary(
  resident: readonly ResidentModel[],
  claimsFor: (model: ResidentModel) => number,
  lastEviction: LastEviction | null,
): ResidencyDoctorSummary {
  const rows: ResidencyDoctorRow[] = resident.map((m) => ({
    endpoint: m.endpoint,
    model: m.model,
    contextLength: m.contextLength,
    claims: claimsFor(m),
  }));
  return { residentModels: rows.length, rows, lastEviction };
}
