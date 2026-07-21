# Progress Report - Native OpenAI Compaction (stub)

**Plan:** `66-native-openai-compaction`
**Stage:** parked stub - one design task; no implementation milestones yet
**Current focus:** Flesh out this plan (1)

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks (total) | 1 |
| Checked (done) | 0 |
| Current-cutoff blockers (unchecked) | 1 |
| Accepted/deferred follow-up | 8 |
| Superseded/obsolete | 0 |

## Current Cutoff

### Flesh out this plan (1)

- [ ] Verify native-compaction support in the public OpenAI API, the current ChatGPT
      Codex OAuth backend, and pi-ai; then decide the provider capability, durable
      checkpoint/replay, fallback, observability, and eval boundaries before replacing
      this stub with concrete RED/GREEN/REFACTOR milestones.

## Accepted/Deferred Follow-Up (design backlog - decide before milestones)

- [ ] Decide whether native compaction targets Codex OAuth, a future direct OpenAI API-key
      provider, or both.
- [ ] Pin pi-ai ownership: upstream support versus a Trevor adapter.
- [ ] Design provider-specific checkpoint persistence and stateless replay.
- [ ] Define restart, fork, model-switch, provider-switch, `/clear`, and `/compact` semantics.
- [ ] Reconcile native token accounting with Trevor's context meter and pressure guards.
- [ ] Define portable fallback behavior without double-compacting normal turns.
- [ ] Define diagnostics and user-visible compaction evidence without exposing opaque data.
- [ ] Build representative quality, cost, latency, and recovery evals before the go/no-go.

## Superseded/Obsolete Checklist Debt

None.
