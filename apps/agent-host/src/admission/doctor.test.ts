import assert from "node:assert/strict";
import { test } from "vitest";
import { admissionDoctorSummary } from "./doctor";
import type { AdmissionRecordView, AdmissionResourceView } from "./store";

/**
 * The /doctor admission projection (plan 11 M8): folds resource snapshots into the active-owners / queue
 * depth / oldest-wait / stale-owner summary the doctor area renders. Pure read model.
 */

const NOW = 1_700_000_100_000;

function record(over: Partial<AdmissionRecordView> & { ownerId: string }): AdmissionRecordView {
  return {
    owner: { ownerId: over.ownerId, hostId: "h", pid: 1, provider: "lmstudio", model: "m" },
    priority: over.priority ?? "foreground",
    estimate: { estimatedTokens: 0, maxOutputTokens: 0, contextWindowTokens: 0 },
    since: over.since ?? new Date(NOW).toISOString(),
    heartbeatAt: over.heartbeatAt ?? new Date(NOW).toISOString(),
    heartbeatAgeMs: over.heartbeatAgeMs ?? 0,
    alive: over.alive ?? true,
    ...over,
  };
}

test("an empty snapshot is an idle summary", () => {
  const s = admissionDoctorSummary([], NOW);
  assert.deepEqual(s, {
    resources: 0,
    activeOwners: 0,
    queued: 0,
    oldestWaitMs: 0,
    staleOwners: 0,
    rows: [],
  });
});

test("summary aggregates active owners, queue depth, oldest wait, and stale owners", () => {
  const views: AdmissionResourceView[] = [
    {
      key: "local-provider:lmstudio:http://x:1234/v1:big",
      capacity: 1,
      active: [record({ ownerId: "a" })],
      queue: [
        // queued 30s and 10s ago (oldest = 30s)
        record({
          ownerId: "q1",
          since: new Date(NOW - 30_000).toISOString(),
          priority: "background",
        }),
        record({
          ownerId: "q2",
          since: new Date(NOW - 10_000).toISOString(),
          priority: "foreground",
        }),
      ],
    },
    {
      key: "local-provider:lmstudio:http://x:1234/v1:small",
      capacity: 1,
      // a crashed holder still listed active (pid not alive) -> stale
      active: [record({ ownerId: "dead", alive: false })],
      queue: [],
    },
  ];
  const s = admissionDoctorSummary(views, NOW);
  assert.equal(s.resources, 2);
  assert.equal(s.activeOwners, 2);
  assert.equal(s.queued, 2);
  assert.equal(s.staleOwners, 1, "the dead-pid active owner counts as stale");
  assert.equal(s.oldestWaitMs, 30_000, "oldest wait across all resources");

  const bigRow = s.rows.find((r) => r.key.endsWith(":big"));
  assert.equal(bigRow?.active, 1);
  assert.equal(bigRow?.queued, 2);
  assert.equal(bigRow?.oldestWaitMs, 30_000);
  assert.equal(bigRow?.topQueuedPriority, "foreground", "the highest-priority waiter is surfaced");

  const smallRow = s.rows.find((r) => r.key.endsWith(":small"));
  assert.equal(smallRow?.staleActive, 1);
  assert.equal(smallRow?.topQueuedPriority, null);
});
