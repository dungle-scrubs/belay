# 44.4 Usage Limit Events — Progress Report

**Stage:** ready

> **Current focus:** Phase 1 · M1 — `assistant.limit` protocol event + loop plumbing

## Summary

| Bucket | Count |
|--------|-------|
| Current-cutoff tasks | 20 |
| Checked (done) | 0 |
| Accepted/deferred follow-up | 0 |
| Superseded/obsolete | 0 |

Milestones: M1–M4 (4). All current-cutoff; no deferred or superseded debt at
authoring time.

---

## Phase 1 — Structured event substrate

### M1: `assistant.limit` protocol event + loop plumbing

- [ ] RED: Failing round-trip test — `assistant.limit` builds → decodes with
      `{provider,status,scope,resetsAt,utilization}` (`packages/session`).
- [ ] GREEN: Builder in `protocol.ts` + decoder in `protocol-decode.ts`.
- [ ] RED: Failing test — a `ProviderEvent{type:"limit"}` through the agent loop
      makes `publishTurn` emit + persist one `assistant.limit` session event.
- [ ] GREEN: `ProviderEvent` variant (`types.ts:62-73`) threaded through
      `AgentEvent` (`loop.ts:85-150`) and `publishTurn` (`turn.ts`).
- [ ] REFACTOR: Extract shared limit payload type + status/scope normalizer;
      module-level comment.

**Gate 1→2**

- [ ] `assistant.limit` round-trips and persists.
- [ ] Synthetic `ProviderEvent{type:"limit"}` yields exactly one session event.

---

## Phase 2 — Provider capture

### M2: Claude Code capture (verified path)

- [ ] RED: Synthetic `SDKRateLimitEvent` (`status:'rejected', resetsAt,
      rateLimitType:'five_hour'`) through `claudeCodeEvents` → `limit`
      ProviderEvent `{status:"reached", scope:"five_hour", resetsAt}`.
- [ ] GREEN: `rate_limit_event` branch in `claudeCodeEvents`
      (`claude-code.ts:150-177`) — status, scope, `resetsAt`, `utilization`.
- [ ] RED: Failing test — `status:'allowed_warning' → "approaching"`.
- [ ] GREEN: Complete status mapping (`allowed→ok`, `allowed_warning→
      approaching`, `rejected→reached`).
- [ ] REFACTOR: Table-drive status/scope mapping; add boundary log line.

### M3: Codex capture + reset-time spike

- [ ] RED (SPIKE): Characterization test of the pi-ai `rate_limited` /
      `quota_billing` error shape — which reset field exists (`retry-after`
      HTTP-date, `x-ratelimit-reset*`, or a snapshot)? Resolves R-1.
- [ ] GREEN: On Codex 429 / `usageLimitExceeded`, emit `limit`
      `{status:"reached"}`; populate `resetsAt` from the spike finding, else
      detect-only + log inspected keys.
- [ ] RED: If a `used_percent` snapshot exists, failing test for `approaching`
      threshold mapping; else record Codex `approaching` as a scoped non-goal.
- [ ] GREEN: Codex `approaching` (best-effort) or record the non-goal decision.
- [ ] REFACTOR: Extend `failure-evidence.ts` to read reset header / HTTP-date
      `retry-after`; taxonomy stays the single classifier.

**Gate 2→3**

- [ ] Claude Code emits `approaching` + `reached` with `scope` + `resetsAt`.
- [ ] Codex emits `reached`; reset path resolved (present or documented gap).

---

## Phase 3 — Consumer surfaces

### M4: Harness projection + web transcript fold

- [ ] RED: Failing test — `projectTranscript`
      (`packages/sdk/src/transcript.ts:39-82`) includes `assistant.limit` rows.
- [ ] GREEN: Add the `assistant.limit` branch to `projectTranscript`.
- [ ] RED: Web transcript fold fixture/Storybook — `assistant.limit` renders a
      marker (`apps/web/src/transcript.ts`).
- [ ] GREEN: Render approaching vs reached with humanized `resetsAt`.
- [ ] REFACTOR: Share `resetsAt` humanizer; module comments on both consumers.

**Gate 3→done**

- [ ] Harness projection exposes `assistant.limit`.
- [ ] Web transcript renders approaching + reached with reset time.
- [ ] `pnpm typecheck` + `pnpm test` green across `session`, `agent-host`,
      `sdk`, `web`.

---

## Accepted / Deferred Follow-up

_None at authoring time._ (Acting on limits — pause / switch / wait — is a
Non-Goal per D-004, tracked for a future plan, not a deferred task of this one.)

## Superseded / Obsolete

_None._
