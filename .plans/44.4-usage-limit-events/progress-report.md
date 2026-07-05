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

- [x] RED: Failing round-trip test — `assistant.limit` builds → decodes with
      `{provider,status,scope,resetsAt,utilization}` (`packages/session`).
- [x] GREEN: Builder in `protocol.ts` + decoder in `protocol-decode.ts`.
- [x] RED: Failing test — a `ProviderEvent{type:"limit"}` through the agent loop
      makes `publishTurn` emit + persist one `assistant.limit` session event.
- [x] GREEN: `ProviderEvent` variant (`types.ts`) threaded through
      `AgentEvent` (`loop.ts` — pure pass-through) and `publishTurn` (`turn.ts`,
      dedup + metric BEFORE the usage catch-all).
- [x] REFACTOR: Shared limit payload type + status/scope normalizer extracted to
      `@trevor/session/usage-limit` (Step 0); module-level comment. `timeUntil`
      humanizer added to `time-format.ts`.

**Gate 1→2**

- [x] `assistant.limit` round-trips and persists.
- [x] Synthetic `ProviderEvent{type:"limit"}` yields exactly one session event
      (+ a dedup test for R-3 within a turn).

---

## Phase 2 — Provider capture

### M2: Claude capture via pi-ai unified rate-limit headers (spike)

_Depends on plan 53.1 — Claude now streams via pi-ai `anthropic-messages`; `claude-code.ts`
and its `SDKRateLimitEvent` branch are deleted (D-007)._

- [x] RED (SPIKE): Characterization over the `anthropic-ratelimit-unified-*` header record
      (`usage-limit.test.ts` + `usage-limit-capture.test.ts`). RESOLVED R-2: pi-ai's
      `StreamOptions.onResponse(response:{status,headers:Record<string,string>})` surfaces ALL raw
      response headers on the SUCCESS path (anthropic-messages.js:354 calls it with every header), so
      an absolute `resetsAt` + `scope` + `utilization` ARE reachable when Anthropic emits the unified
      headers. Capture is a REAL success-path read (not the error path).
- [x] GREEN: `onResponse` wired in `pi-ai.ts` → `anthropicLimitEvent` maps `-status` → enum, the
      5h/7d(-opus) window → `scope`, `-reset` → `resetsAt`, remaining/limit → `utilization`; the
      `limit` ProviderEvent is drained as the step's FIRST event. Absent header → detect-only +
      `usage-limit-absent` log listing the inspected keys.
- [x] RED: `allowed_warning → "approaching"` asserted (usage-limit + usage-limit-capture tests).
- [x] GREEN: Full status mapping (`allowed→ok`, `allowed_warning→approaching`, `rejected→reached`).
- [x] REFACTOR: Shared, table-driven mapping lives in `@trevor/session/usage-limit`; the reset parse
      (`parseResetToEpochSeconds`) is shared and handles integer-seconds / RFC3339 / HTTP-date; a
      structured `usage-limit` boundary log line is emitted on every capture.

### M3: Codex capture + reset-time spike

- [x] RED (SPIKE): `failureLimitEvent` characterization (`usage-limit-capture.test.ts`) over the
      pi-ai `rate_limited` / `quota_billing` error shape. RESOLVED R-1: pi-ai strips the APIError to a
      message string before the host sees it, so on the 429 ERROR path NO headers reach us - the reset
      is not reliably exposed. `resetsAt` rides ONLY when a retry-after delta is present (integer
      seconds via `retryAfterMsOf`, converted to an absolute epoch); otherwise detect-only.
- [x] GREEN: On a rate/quota failure (a Codex 429 / usageLimitExceeded classified `rate_limited` or
      `quota_billing`), the pi-ai boundary emits `limit {status:"reached", scope:"unknown"}` before
      re-throwing; `resetsAt` from a retry-after when present, else detect-only + a `usage-limit` log
      noting the reset is absent. The taxonomy stays the single classifier.
- [x] RED/GREEN: Codex `approaching` recorded as a **scoped non-goal** (R-4 holds) - no per-turn
      `used_percent` snapshot is reachable on the pi-ai error path (pi-ai surfaces only the thrown
      APIError message, no in-band usage snapshot), so Codex ships `reached`-only. Claude `approaching`
      still ships (M2 success headers).
- [x] REFACTOR: The HTTP-date reset parse the plan flagged as a gap in `failure-evidence.ts` is added
      in the SHARED normalizer (`parseResetToEpochSeconds`), ready to wire if a Codex reset header ever
      surfaces; `failure-evidence.ts` is left untouched so the taxonomy stays the single classifier.

**Gate 2→3**

- [x] Claude emits `approaching` + `reached`; reset/scope resolved - present via the unified success
      headers (onResponse), documented detect-only fallback when absent.
- [x] Codex emits `reached`; reset path resolved - documented gap (headers stripped on the error path),
      detect-only with a logged reason. `approaching` scoped as a non-goal.

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
