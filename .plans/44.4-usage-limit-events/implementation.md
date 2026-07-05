# 44.4 Usage Limit Events — Implementation Plan

Capture "usage limit approaching / reached + reset time" from the two agent
providers (Claude Code, Codex) as a structured, first-class transcript event
that a downstream consumer — the eval/automation harness or, later, the
supervisor — can read and eventually act on.

## 0. Hard Dependencies

- [ ] **Plan 53.1 (Claude subscription sign-in) — hard dependency.** 53.1 retires the
  Agent-SDK `claude-code` route and streams the Claude subscription through pi-ai
  `anthropic-messages`, which **deletes** `claude-code.ts` and its `SDKRateLimitEvent`
  branch. Claude rate-limit capture therefore moves off the SDK onto the pi-ai HTTP path
  (see D-007 / M2). Implement 53.1 first. <!-- D-007 -->

The rest of the substrate already exists:

- After 53.1, Claude streams via pi-ai `anthropic-messages` — the **same pi-ai HTTP
  client as Codex** — whose responses carry `anthropic-ratelimit-unified-*` headers
  (`status: allowed|allowed_warning|rejected`, reset, 5h/7d scope), the same status enum
  this plan's D-005 already normalizes. <!-- D-007 -->
- A mature failure taxonomy already classifies `rate_limited` / `quota_billing`
  and mines `retry-after` seconds
  (`apps/agent-host/src/providers/failure-taxonomy.ts:131-178`,
  `failure-evidence.ts:147-165`).
- The transcript is an append-only SQLite event log with opaque JSON payloads —
  a new event kind persists for free (`apps/session-store/src/log.ts:77-129`).

## Architecture

<!-- D-001 --> The signal reaches the transcript as a **dedicated first-class
protocol event `assistant.limit`**, not a piggyback on `ProviderDiagnostic`.
`ProviderDiagnostic` only rides failure/reconnect events; the provider's rate-limit
signal (Claude's `anthropic-ratelimit-unified-status: allowed_warning`, a Codex
snapshot) also fires on non-failure ("approaching") states that a failure-only channel
cannot carry.

The flow mirrors every other model signal in Trevor: a provider-boundary mapper
emits a normalized `ProviderEvent`, the agent loop lifts it to an `AgentEvent`,
`publishTurn` maps it to a durable session event, and the append-only log
persists it. Two consumers then read it.

```
pi-ai (Claude) ──anthropic-ratelimit-unified hdr──┐
                                                  ├─► ProviderEvent{type:"limit"} ─► AgentEvent
pi-ai (Codex) ──429 / rate-limit hdr──────────────┘        (types.ts)               (loop.ts)
                                                                            │
                                                                   publishTurn (turn.ts)
                                                                            │
                                                            assistant.limit session event
                                                              (protocol.ts / protocol-decode.ts)
                                                                            │
                                                            session-store append-only log
                                                             ┌──────────────┴──────────────┐
                                                   web transcript fold           sdk projectTranscript
                                                  (apps/web/src/transcript.ts)  (packages/sdk/src/transcript.ts)
                                                                                    = "the harness"
```

### Event contract

<!-- D-005 --> <!-- D-006 --> One provider-agnostic payload:

| Field | Type | Notes |
|-------|------|-------|
| `provider` | `string` | `"anthropic"` \| `"codex"` \| ... |
| `status` | `"ok" \| "approaching" \| "reached"` | Trevor-native, normalized across providers |
| `scope` | `string` | window id: `"five_hour" \| "seven_day" \| "seven_day_opus" \| ...` |
| `resetsAt` | `number?` | unix epoch **seconds** when the window resets (optional) |
| `utilization` | `number?` | 0–1 or 0–100 fraction used, when the provider supplies it (optional) |

Status normalization (D-005): Claude pi-ai `anthropic-ratelimit-unified-status`
`allowed→ok`, `allowed_warning→approaching`, `rejected→reached`; Codex 429 /
`usageLimitExceeded → reached`, snapshot `used_percent` over threshold `→ approaching`.
The Claude status enum is unchanged from the retired SDK event; only its source moved to
the HTTP header (53.1). <!-- D-007 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Trevor does NOT run the vendor CLIs (no PTY, no `claude -p`, no `codex exec`) | After 53.1 both providers stream via the pi-ai HTTP client; signals come from its response headers, not terminal scraping. The earlier "TUI chrome" concern does not apply. |
| After 53.1, Claude AND Codex reset are both unverified on the pi-ai path | Both reset-time captures are **spikes** with detect-only fallbacks (D-002 / D-007). The prior "Claude reset verified via the SDK" no longer holds — the SDK route is gone. |
| `retry-after` HTTP-date form is deliberately ignored today (`failure-evidence.ts:144-146`) | The absolute-reset path for Codex must be added, not assumed present. |
| `retryAfterMs` is extracted internally but dropped before the wire (`errors.ts:32,115`; not in `protocol.ts:73-86`) | The new event is the first thing to actually surface reset data to a consumer. |

### Boundaries

- **The pi-ai boundary owns translation for both providers.** After 53.1 Claude and
  Codex both stream through pi-ai (`pi-ai.ts:208-365`, `failure-taxonomy.ts`,
  `failure-evidence.ts`), so one mapping point reads the `anthropic-ratelimit-unified-*`
  headers (Claude) and the 429 / rate-limit shape (Codex) → the single
  `ProviderEvent{type:"limit"}`. No consumer ever sees a provider-native rate-limit
  shape. <!-- D-007 -->
- **The agent loop and `turn.ts` are pass-through.** They forward the event;
  they do not interpret or act on it.
- **Non-goal boundary (D-004):** nothing in this plan changes routing, retry,
  or provider selection based on a limit. Detection only.

### Observability

This touches provider/transport/recovery behavior, so observability is part of
the feature, not an afterthought:

- A structured boundary log at each capture point: `{provider, status, scope,
  resetsAt, utilization, sessionId}` — one line when a limit event is emitted.
- The event itself is the user-visible inspection surface (it lands in the
  transcript and both consumers render/expose it).
- The Codex spike (M3) must log the *raw* error header/body keys it inspected,
  so the detect-only fallback is explained in the log, not silent.

---

## Phases

### Phase 1: Structured event substrate

**Goal:** `assistant.limit` exists end-to-end and persists — provider-agnostic,
before either provider is wired.

#### M1: `assistant.limit` protocol event + loop plumbing

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a failing round-trip test for an `assistant.limit` protocol event
     (build → decode) carrying `{provider,status,scope,resetsAt,utilization}`
     (`packages/session` protocol tests).
  2. GREEN: Add the builder in `packages/session/src/protocol.ts` and the
     decoder in `packages/session/src/protocol-decode.ts`. <!-- D-001 -->
  3. RED: Add a failing test that a `ProviderEvent{type:"limit"}` fed through
     the agent loop causes `publishTurn` to emit and persist one
     `assistant.limit` session event (`apps/agent-host` loop/turn tests).
  4. GREEN: Add the `{type:"limit"; status; scope; resetsAt?; utilization?}`
     variant to `ProviderEvent` (`apps/agent-host/src/providers/types.ts:62-73`),
     thread it through `AgentEvent` (`apps/agent-host/src/agent/loop.ts:85-150`)
     and `publishTurn` (`turn.ts`).
  5. REFACTOR: Extract the shared limit payload type + status/scope normalizer
     into one module; add a module-level comment stating what it owns.

### Gate 1→2

- [ ] `assistant.limit` round-trips and persists to the append-only log.
- [ ] A synthetic `ProviderEvent{type:"limit"}` produces exactly one session event.

### Phase 2: Provider capture

**Goal:** Both providers emit `assistant.limit`; Claude Code fully, Codex with a
verified reset path or a documented detect-only fallback.

#### M2: Claude capture via the pi-ai unified rate-limit headers (spike)

- **Dependencies:** M1, plan 53.1 (Claude now streams via pi-ai `anthropic-messages`)
- **Effort:** M
- **Tasks:**
  1. RED (SPIKE): Add a characterization test over a real pi-ai `anthropic-messages`
     response asserting which `anthropic-ratelimit-unified-*` headers pi-ai's HTTP client
     surfaces — `-status` (`allowed|allowed_warning|rejected`), `-reset` (absolute), and
     the 5h/7d scope headers. Resolves whether an absolute Claude `resetsAt` + `scope` are
     reachable on the pi-ai path (R-2). <!-- D-007 -->
  2. GREEN: At the pi-ai boundary map the unified headers → a `limit` ProviderEvent:
     `-status` → status enum, the 5h/7d window → `scope`, `-reset` → `resetsAt`,
     `utilization` from the remaining/limit pair when present. When a header is absent,
     emit detect-only and log the inspected keys (no silent gap). <!-- D-002 --> <!-- D-007 -->
  3. RED: Add a failing test for `allowed_warning → "approaching"` from the header.
  4. GREEN: Complete the status mapping (`allowed→ok`, `allowed_warning→
     approaching`, `rejected→reached`). <!-- D-003 --> <!-- D-005 -->
  5. REFACTOR: Share the unified-header read with the Codex reset path (M3) in
     `failure-evidence.ts`; table-drive the status/scope mapping; add a boundary log line.

#### M3: Codex capture + reset-time spike

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED (SPIKE): Add a characterization test that captures the real pi-ai
     `rate_limited` / `quota_billing` error object shape and asserts which
     reset-bearing fields exist — `retry-after` (HTTP-date form at
     `failure-evidence.ts:144-146`), `x-ratelimit-reset*` headers, or a per-turn
     rate-limit snapshot. This resolves whether an absolute Codex `resetsAt` is
     reachable on the pi-ai path (R-1). <!-- D-002 -->
  2. GREEN: On a Codex 429 / `usageLimitExceeded`, emit a `limit` ProviderEvent
     `{status:"reached"}`; populate `resetsAt` from whatever the spike found
     (HTTP-date `retry-after` → absolute, or reset header, else omit). When no
     reset is exposed, emit detect-only and log the inspected keys (no silent gap).
  3. RED: If the spike finds a per-turn rate-limit snapshot with `used_percent`,
     add a failing test for `approaching` (threshold) mapping; otherwise record
     Codex `approaching` as a scoped non-goal for this plan.
  4. GREEN: Implement Codex `approaching` (best-effort) or record the non-goal
     decision.
  5. REFACTOR: Extend `failure-evidence.ts` to read the reset header / HTTP-date
     `retry-after` cleanly; keep the taxonomy the single classification source.

### Gate 2→3

- [ ] Claude emits `approaching` + `reached`; reset/scope resolved (present via unified headers, or documented gap).
- [ ] Codex emits `reached`; reset path resolved (present, or documented gap).

### Phase 3: Consumer surfaces

**Goal:** The event is readable by the harness projection and visible in the web
transcript.

#### M4: Harness projection + web transcript fold

- **Dependencies:** M1 (M2/M3 for real fixtures)
- **Effort:** S
- **Tasks:**
  1. RED: Add a failing test that `projectTranscript`
     (`packages/sdk/src/transcript.ts:39-82`) includes `assistant.limit` rows so
     the harness sees them (today it keeps only user/assistant.completed/
     command.result/tool.completed).
  2. GREEN: Add the `assistant.limit` branch to `projectTranscript`.
  3. RED: Add a web transcript fold expectation (fixture/Storybook) that an
     `assistant.limit` event renders a limit marker
     (`apps/web/src/transcript.ts`).
  4. GREEN: Render the marker (approaching vs reached; humanized `resetsAt`).
  5. REFACTOR: Share the `resetsAt` humanizer; add module comments to the two
     consumer branches.

### Gate 3→done

- [ ] Harness projection exposes `assistant.limit`.
- [ ] Web transcript renders approaching + reached markers with reset time.
- [ ] `pnpm typecheck` + `pnpm test` green across `session`, `agent-host`,
      `sdk`, `web`.

---

## Non-Goals

- **Acting on a limit** — pausing a session, switching provider/model, or
  waiting until reset. <!-- D-004 --> This plan is the detection substrate; the
  harness/supervisor acting on it is future work.
- **Account-usage polling** (V1's external `usage --json` poller / ccusage
  style). We capture only the in-band signal the active session already
  produces, not an out-of-band account query.
- **A usage dashboard / rich UI.** A transcript marker is the surface; a
  dedicated usage panel is out of scope.
- **Guaranteeing `resetsAt` on the pi-ai path.** If pi-ai does not expose the reset
  header for Claude (unified) or Codex, that provider ships detect-only (reached, no
  reset) with a logged, documented gap. <!-- D-007 -->

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| R-1: pi-ai does not surface a Codex reset timestamp | medium | medium | M3 spike resolves it empirically before wiring; detect-only fallback keeps the plan shippable (D-002) | impl |
| R-2: pi-ai does not surface the `anthropic-ratelimit-unified-*` headers on the OAuth/subscription path | medium | medium | M2 spike resolves it empirically before wiring; detect-only fallback (reached, no reset/scope) keeps the plan shippable, mirroring the Codex path (D-007) | impl |
| R-3: Provider spam of `approaching` events floods the transcript | low | medium | Emit on status *transition* / dedupe per (scope,status) within a turn; covered by an M2/M3 test | impl |
| R-4: Codex `approaching` never available (no snapshot on pi-ai path) | low | medium | Scoped as best-effort / non-goal per M3.3; Claude Code `approaching` still ships | impl |

---

## Escape Hatches

1. **If R-1 fails (no Codex reset exposed):** ship Codex detect-only —
   `status:"reached"` without `resetsAt`, logged gap — and file the reset path
   as a follow-up (would require a pi-ai enhancement or a different Codex
   integration surface).
2. **If R-4 holds (no Codex snapshot):** Codex emits `reached` only;
   `approaching` remains Claude-Code-only for this plan.

---

## Progress Report Accounting

See `progress-report.md`. Buckets: current-cutoff blockers (M1–M4 tasks),
no deferred/superseded debt at authoring time. Current focus starts at M1 RED.

---

## Validation Commands

```bash
pnpm typecheck
pnpm test --filter @trevor/session --filter @trevor/agent-host \
  --filter @trevor/sdk --filter @trevor/web
```

---

## Decisions

Canonical decisions live in `.plans/44.4-usage-limit-events/plan.db`
(D-001…D-007). Query:

```bash
mise x node@22 -- npx tsx ~/.agents/skills/planner/scripts/plan-db.ts \
  query-decisions --plan "44.4-usage-limit-events"
```
