# Orphaned Background Reconcile - Progress Report

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 31 |
| Completed | 0 |
| Deferred / future-phase | 0 |
| Superseded | 0 |

**Current focus:** Phase 1 M1 - widen the `delegated.to` status enum with `interrupted`.

**Stage:** RFC -> READY (design fully agreed; this plan enters the backlog at `ready`, implementation begins on its own `feat/52-*` branch off `main`).

---

## Phase 1: The protocol seam

**Goal:** `delegated.to` carries `status:"interrupted"` end to end - builder, decoder,
transcript reducer, support-panel consumers - while every existing emit path still only
produces `running|done|failed` (behavior byte-identical until Phase 2).

### M1: Widen the `delegated.to` status enum with `interrupted`

- [ ] RED: Protocol round-trip test - `delegatedTo({..., status:"interrupted"})` builds and decodes back to `"interrupted"`. <!-- D-002 -->
- [ ] GREEN: Widen the `status` union to `running|done|failed|interrupted` on the builder (`protocol.ts:508`) and the decoded `DelegatedTo` type; keep the decoder default `"running"`.
- [ ] RED: Transcript-reducer test - a later `delegated.to{status:"interrupted"}` advances the existing block in place by `childSessionId`, no second card (`transcript.ts:633`).
- [ ] GREEN: Reducer treats `interrupted` as a valid terminal status alongside `done|failed`.
- [ ] RED: Support-panel test - `runningSubagents` excludes an `interrupted` child; `subagentRow` maps `interrupted` to an error/terminal tone with an `"interrupted"` label (`support-panel.ts:114,124`).
- [ ] GREEN: Update `runningSubagents` and `subagentRow` for the new variant.
- [ ] REFACTOR: Introduce `isTerminalDelegationStatus`, reused by the reducer, `runningSubagents`, and `subagentRow`.

---

## Phase 2: Two-sided subagent reconcile

**Goal:** An orphaned background subagent is closed to `interrupted` on BOTH the host
takeover path and the browser last-resort path, keyed by `childSessionId`; the two
converge on one terminal link. <!-- D-001 -->

### M2: Browser-side subagent orphan auto-reconcile (mirror `reconcileTurn`)

- [ ] RED: `derive.ts` test for `detectOrphanedSubagents(events, check)` - returns orphaned `childSessionId`(s) only when `!leaderPresent` + `connected` + silent past `graceMs`; none while a leader is present, disconnected, within grace, or once terminal. <!-- D-001 -->
- [ ] GREEN: Implement `detectOrphanedSubagents` reusing `OrphanCheck` + the same `ORPHAN_GRACE_MS` / silent-past-grace logic as `detectOrphanedTurn`.
- [ ] RED: `use-session` test - `reconcileSubagent(link)` publishes a terminal `delegated.to{status:"interrupted"}` keyed by `childSessionId` (carrying `runId`/`agent`/`task`/`mode`), with a recovery summary in `result`.
- [ ] GREEN: Add `reconcileSubagent` to `createSessionActions` (`use-session.ts`) mirroring `reconcileTurn`.
- [ ] RED: App-wiring test - the effect fires `reconcileSubagent` at most once per `childSessionId` (a `reconciledSubagentRef` guard mirroring `reconciledRunRef` `app.tsx:397`) and never while a leader is present.
- [ ] GREEN: Wire the detector -> action effect in `app.tsx` behind `reconciledSubagentRef`, alongside the turn path.
- [ ] REFACTOR: Factor the shared "no leader + connected + silent past grace" gate so the turn and subagent detectors read one predicate.

### M3: Host-side subagent reap on leadership takeover (mirror `reapExcept`)

- [ ] RED: Host test - on taking leadership with an orphaned `delegated.to{status:"running"}` in the replayed parent log (NOT in this host's `backgroundChildren`), the host emits a terminal `delegated.to{status:"interrupted"}`. <!-- D-001 -->
- [ ] GREEN: Add `reapOrphanSubagents()` alongside the turn reap (`run-lifecycle.ts:78`), excluding children this host is actively running - the subagent analogue of `reapExcept(activeRunId)`.
- [ ] RED: A subagent this host is itself running (present in `backgroundChildren`) is NOT reaped.
- [ ] GREEN: Thread the live `backgroundChildren` keyset into the reap as the exclusion set (`start-turn.ts:159` / `main.ts`).
- [ ] RED: Idempotency - a second takeover after the interrupted link is already in the log emits nothing further.
- [ ] GREEN: The log-derived scan treats any terminal status (`done|failed|interrupted`) as closing the link.
- [ ] REFACTOR: Call `reapOrphanSubagents()` from the same two leadership hooks as `reapOrphans()` (`boot/leadership.ts:127,205`).

---

## Phase 3: Jobs derive-layer reconcile and end-to-end verification

**Goal:** A dead host's `running` jobs render as terminal/interrupted (pure derivation,
no event), and subagent + job together settle to "no background work running" after
reconcile, without duplicates.

### M4: Promoted shell jobs - derive-layer reconcile of a stale snapshot

- [ ] RED: `derive.ts` test - the jobs derivation renders a `running` job as terminal/interrupted when the latched `host.online` came from a non-leader host (`hostStatus.leaderId` differs / not present `derive.ts:181-292`), and leaves it `running` when its author is still the leader. <!-- D-003 -->
- [ ] GREEN: Pass the `hostStatus` liveness verdict into the jobs derivation (`jobsFrom` `derive.ts:348`); downgrade `running` jobs to interrupted for a stale author. No new event.
- [ ] RED: `support-panel` test - `jobRow`/`jobOutcome` render a reconciled job with an interrupted/terminal tone + label; `jobToDetailModel` reflects the terminal status (`support-panel.ts:82-148`).
- [ ] GREEN: Reconciled status flows through `jobOutcome`/`jobRow`; the job kill control (`support-panel-view.tsx`) is inert for a reconciled job.
- [ ] REFACTOR: Keep the reconcile pure and presentation-only - one place computes "snapshot author is stale," reused by the jobs derivation.

### M5: End-to-end orphan reconcile verification and consolidation

- [ ] RED: Integration test (hermetic host lane) - start a background subagent, drop the leader mid-flight, take leadership on a second host, assert exactly ONE terminal `delegated.to{status:"interrupted"}` for the child (no duplicate when a browser also observes the gap).
- [ ] GREEN: Confirm the two paths converge on one card via the reducer's in-place advance keyed by `childSessionId` + idempotent terminal keys; pin it.
- [ ] RED: Derive/UI test - a session whose only in-flight background work is an orphaned subagent AND a dead-host running job settles to "no background work running" after reconcile.
- [ ] GREEN: Confirm the support-panel background rows reflect both reconciles together.
- [ ] REFACTOR: Consolidate the orphan-reconcile surface - one documented `ORPHAN_GRACE_MS`, one silent-past-grace predicate shared by the turn + subagent detectors, and a module comment naming the three reconciled kinds (turn, subagent, job) and why jobs differ (D-003).

---

## Decisions

- **D-001** Background subagents mirror the turn reconcile - two-sided (host reap on takeover + browser last-resort), keyed by `childSessionId`.
- **D-002** Widen the `delegated.to` status enum with `interrupted` so an orphan-reap is distinguishable from a real failure.
- **D-003** Promoted shell jobs are a derive-layer presentation fix, NOT an event - a dead host's snapshot renders its `running` jobs as interrupted.

## Notes

- The `delegated.to` wire shape is unchanged (a string `status`); the decoder already
  coerces unknown strings to a default, so old logs decode unchanged and the widening
  is a TS-type + consumer change only.
- Host reap and browser reconcile are idempotent by `childSessionId`: the transcript
  reducer advances one delegation block in place, so both paths converge on one
  `interrupted` card even if they fire together.
- Jobs cannot mirror the reconcile because they have no durable event - they exist only
  on the `host.online` snapshot - so their fix is a pure derivation over host liveness
  (D-003), keeping jobs presentation-only per the non-goals.
