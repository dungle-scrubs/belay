import { priorityRank } from "./contract";
import type { AdmissionRecordView, AdmissionResourceView } from "./store";

/**
 * The /doctor projection for local admission (plan 11 M8): folds the raw per-resource lease/queue views
 * into the redaction-safe summary the doctor Admission area renders - active local-model owners, queue
 * depth, the oldest wait, and any stale holder (a dead pid still listed active). Pure read model: it
 * reads the snapshot, never mutates. Resource keys (provider:host:port:model) carry no secret, so they
 * surface as-is for operator diagnosis.
 */

/** One resource row in the doctor admission summary. */
export interface AdmissionDoctorRow {
  readonly key: string;
  readonly capacity: number;
  readonly active: number;
  readonly queued: number;
  /** The oldest queued wait on this resource (ms), or 0 when nothing waits. */
  readonly oldestWaitMs: number;
  /** Active holders whose pid is no longer alive (a crashed owner not yet reaped). */
  readonly staleActive: number;
  /** The highest-priority class currently waiting, or null when the queue is empty. */
  readonly topQueuedPriority: string | null;
}

/** The aggregate admission state /doctor shows. */
export interface AdmissionDoctorSummary {
  readonly resources: number;
  readonly activeOwners: number;
  readonly queued: number;
  readonly oldestWaitMs: number;
  readonly staleOwners: number;
  readonly rows: readonly AdmissionDoctorRow[];
}

/** The age (ms) of a queued record's `since` (enqueue) timestamp - how long it has waited. */
function waitMs(record: AdmissionRecordView, nowMs: number): number {
  const since = Date.parse(record.since);
  return Number.isFinite(since) ? Math.max(0, nowMs - since) : 0;
}

/** Builds the doctor admission summary from the resource snapshot at `nowMs`. */
export function admissionDoctorSummary(
  views: readonly AdmissionResourceView[],
  nowMs: number,
): AdmissionDoctorSummary {
  const rows: AdmissionDoctorRow[] = [];
  let activeOwners = 0;
  let queued = 0;
  let staleOwners = 0;
  let oldestWaitMs = 0;
  for (const view of views) {
    const staleActive = view.active.filter((r) => !r.alive).length;
    const rowOldest = view.queue.reduce((max, r) => Math.max(max, waitMs(r, nowMs)), 0);
    const topQueued = [...view.queue].sort(
      (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
    )[0];
    activeOwners += view.active.length;
    queued += view.queue.length;
    staleOwners += staleActive;
    oldestWaitMs = Math.max(oldestWaitMs, rowOldest);
    rows.push({
      key: view.key,
      capacity: view.capacity,
      active: view.active.length,
      queued: view.queue.length,
      oldestWaitMs: rowOldest,
      staleActive,
      topQueuedPriority: topQueued?.priority ?? null,
    });
  }
  return { resources: views.length, activeOwners, queued, oldestWaitMs, staleOwners, rows };
}
