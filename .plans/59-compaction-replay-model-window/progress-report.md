# Compaction Replay Model Window Progress Report

**Plan:** `59-compaction-replay-model-window`
**Stage:** ready (authored; not yet implemented)
**Current focus:** M1 - Reproduce The Stale Replay Window (0/5)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 30 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 30 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

All five milestones and the final gate are current-cutoff. Nothing is deferred.

---

## M1 - Reproduce The Stale Replay Window (0/5)

- [ ] RED: Characterize the failing replay sequence: old small-window usage, later larger-window turn, new large-window `ModelRef` prompt, and no blocking-before compaction.
- [ ] GREEN: Add only the minimum test harness seams for replayed prompt, progress, completion, and scheduler compaction calls.
- [ ] RED: Prove provider changes reset the retained budget window during replay, not only live start.
- [ ] GREEN: Pin the current failure before production behavior changes.
- [ ] REFACTOR: Name the fixture after the product rule, for example `replayedForegroundWindow`.

## M2 - Extract Shared Turn Provider Resolution (0/5)

- [ ] RED: Resolver tests cover catalog `ModelRef`, legacy provider ids, unknown source fallback, and reasoning-preserving input.
- [ ] GREEN: Extract current provider selection from `startTurn` into one typed resolver helper.
- [ ] RED: Assert `startTurn` and preflight resolve the same provider for the same `user.message`.
- [ ] GREEN: Rewire `startTurn` to consume the helper with no behavior change.
- [ ] REFACTOR: Add module ownership comments and remove duplicated selection comments.

## M3 - Rebuild Compaction Provider State During Replay (0/5)

- [ ] RED: Replay-order test proves answerable `user.message` observes provider identity before usage updates compaction state.
- [ ] GREEN: In `handleEvent`, resolve provider and call `compactionController.noteProvider(provider)` before `scheduler.noteTurn(message)`.
- [ ] RED: Reconnect test proves compaction state resets before full replay, including last input, latest window, retained window, provider, floor marker, and last fold.
- [ ] GREEN: Add `CompactionController.resetForReplay()` and call it from `connect()` beside existing replay resets.
- [ ] REFACTOR: Keep compaction replay mutation paths named and colocated.

## M4 - Fix Blocking-Before Preflight For New Prompts (0/5)

- [ ] RED: Host characterization proves a new prompt's provider is observed before `compaction.needed()` can run.
- [ ] GREEN: Wire live prompt preflight without moving provider logic into `TurnScheduler`.
- [ ] RED: A genuinely over-budget prompt on a smaller selected model still triggers blocking-before compaction.
- [ ] GREEN: Preserve `COMPACT_WHEN` and retained-window behavior for same-provider and interleaved larger-window turns.
- [ ] REFACTOR: Tighten blocking-before comments to name provider preflight as part of the contract.

## M5 - Expose And Verify The Budget Snapshot (0/5)

- [ ] RED: `/doctor` or host-facts test expects latest served window and retained budget window separately.
- [ ] GREEN: Add a compaction budget snapshot and render it in host facts.
- [ ] RED: Regression covers the observed shape: latest `20.9k / 262k`, retained stale `6144`, and a new large-window prompt.
- [ ] GREEN: Make diagnostics best-effort and non-throwing.
- [ ] REFACTOR: Remove incident-only debug code and keep wording compact.

---

## Gate 1->done

- [ ] Stale replay-window regression fails before the fix and passes after shared resolver plus replay reset land.
- [ ] Existing compaction-controller tests for undercounting providers, interleaved larger windows, and genuine foreground upgrades still pass.
- [ ] `TurnScheduler` remains provider-agnostic.
- [ ] `/doctor` or host facts expose retained budget window separately from latest served window.
- [ ] Unit, integration, typecheck, lint, and hermetic e2e gates pass or have stated unrelated blockers.

## Deferred Follow-Up

None.
