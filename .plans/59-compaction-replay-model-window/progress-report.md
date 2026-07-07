# Compaction Replay Model Window Progress Report

**Plan:** `59-compaction-replay-model-window`
**Stage:** implementing
**Current focus:** Gate 1->done

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 30 |
| Checked (done) | 30 |
| Current-cutoff blockers (unchecked) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All five milestones and the final gate are current-cutoff. Nothing is deferred.

---

## M1 - Reproduce The Stale Replay Window (5/5)

- [x] RED: Characterize the failing replay sequence: old small-window usage, later larger-window turn, new large-window `ModelRef` prompt, and no blocking-before compaction.
- [x] GREEN: Add only the minimum test harness seams for replayed prompt, progress, completion, and scheduler compaction calls.
- [x] RED: Prove provider changes reset the retained budget window during replay, not only live start.
- [x] GREEN: Pin the current failure before production behavior changes.
- [x] REFACTOR: Name the fixture after the product rule, for example `replayedForegroundWindow`.

## M2 - Extract Shared Turn Provider Resolution (5/5)

- [x] RED: Resolver tests cover catalog `ModelRef`, legacy provider ids, unknown source fallback, and reasoning-preserving input.
- [x] GREEN: Extract current provider selection from `startTurn` into one typed resolver helper.
- [x] RED: Assert `startTurn` and preflight resolve the same provider for the same `user.message`.
- [x] GREEN: Rewire `startTurn` to consume the helper with no behavior change.
- [x] REFACTOR: Add module ownership comments and remove duplicated selection comments.

## M3 - Rebuild Compaction Provider State During Replay (5/5)

- [x] RED: Replay-order test proves answerable `user.message` observes provider identity before usage updates compaction state.
- [x] GREEN: In `handleEvent`, resolve provider and call `compactionController.noteProvider(provider)` before `scheduler.noteTurn(message)`.
- [x] RED: Reconnect test proves compaction state resets before full replay, including last input, latest window, retained window, provider, floor marker, and last fold.
- [x] GREEN: Add `CompactionController.resetForReplay()` and call it from `connect()` beside existing replay resets.
- [x] REFACTOR: Keep compaction replay mutation paths named and colocated.

## M4 - Fix Blocking-Before Preflight For New Prompts (5/5)

- [x] RED: Host characterization proves a new prompt's provider is observed before `compaction.needed()` can run.
- [x] GREEN: Wire live prompt preflight without moving provider logic into `TurnScheduler`.
- [x] RED: A genuinely over-budget prompt on a smaller selected model still triggers blocking-before compaction.
- [x] GREEN: Preserve `COMPACT_WHEN` and retained-window behavior for same-provider and interleaved larger-window turns.
- [x] REFACTOR: Tighten blocking-before comments to name provider preflight as part of the contract.

## M5 - Expose And Verify The Budget Snapshot (5/5)

- [x] RED: `/doctor` or host-facts test expects latest served window and retained budget window separately.
- [x] GREEN: Add a compaction budget snapshot and render it in host facts.
- [x] RED: Regression covers the observed shape: latest `20.9k / 262k`, retained stale `6144`, and a new large-window prompt.
- [x] GREEN: Make diagnostics best-effort and non-throwing.
- [x] REFACTOR: Remove incident-only debug code and keep wording compact.

---

## Gate 1->done

- [x] Stale replay-window regression fails before the fix and passes after shared resolver plus replay reset land.
- [x] Existing compaction-controller tests for undercounting providers, interleaved larger windows, and genuine foreground upgrades still pass.
- [x] `TurnScheduler` remains provider-agnostic.
- [x] `/doctor` or host facts expose retained budget window separately from latest served window.
- [x] Unit, integration, typecheck, lint, and hermetic e2e gates pass or have stated unrelated blockers.

## Deferred Follow-Up

None.
