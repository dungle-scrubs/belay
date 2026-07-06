# 09.4 Inline-Agent Transcript Row — Implementation Plan

An inline delegation (`delegate_inline`) currently renders up to **four** times for one
child: the `delegate_inline()` tool-call chip, the purple `ToneAlert` block
(`apps/web/src/components/chat/transcript-row-view.tsx:346`), the pinned
`running delegate_inline (…)` turn-status line (`apps/web/src/components/chat/turn-status-header.tsx`),
and a `BACKGROUND N · ◆ explorer` row in the support panel (`runningSubagents`,
`apps/web/src/support-panel/support-panel.ts:142`, which has **no mode filter** so a blocking
inline child leaks under a header literally labeled BACKGROUND). This plan collapses inline
delegation to a single compact inline-agent transcript row, gives it a details view, and removes
it from the BACKGROUND group. Background/async delegation is unchanged.

## 0. Hard Dependencies

None. Every surface this plan touches is already shipped and present in the tree:
- the delegation mechanism + `delegated.to` event (`apps/agent-host/src/agent/delegate.ts`, `packages/session/src/protocol.ts:600`),
- the support panel + BACKGROUND group (plan 09, `apps/web/src/support-panel/`),
- the pinned turn-status header + shared elapsed hook (`apps/web/src/components/chat/turn-status-header.tsx`, `apps/web/src/hooks/use-elapsed-label.ts`),
- the tool-detail takeover chrome (`apps/web/src/tool-detail/`, `apps/web/src/components/panel/panel-host.tsx`),
- the tasks-panel tree glyph (`apps/web/src/tasks-panel.tsx:45`).

Soft coexistence only (no ordering constraint): plan `50-cli-headless-agent-surface` is associated
with the turn-status header. Its current `implementation.md` records no delegation/turn-status/elapsed
work, so there is no contract to sequence against; see Downstream Accommodation.

## Architecture

The change is almost entirely in the **web** read/render layer, with one small **protocol +
host** extension to carry the row's live metadata. The delegation *mechanism*
(`runDelegatedChild`, isolation, `MAX_DELEGATION_DEPTH=1`, background clamp) is untouched.

Four surfaces, one child:

1. **Transcript row (new).** A `delegated.to{mode:"inline"}` link reduces to a new `inlineAgent`
   transcript message. It renders as a compact one-line row — `agent · model · thinking ·
   (elapsed · ↓ tokens)` — visually distinct from tool cards. A **single** inline agent is a bare
   row (no tree glyph). **Parallel** inline agents from one parent turn (the host runs tool calls at
   `toolConcurrency`, `apps/agent-host/src/agent/loop.ts:1091`, so one assistant message can spawn
   several `delegate_inline`) group under a header with the `└` tree-indent reused from
   `tasks-panel.tsx:45`. Storybook-first; the component ships **full** and **compact** variants
   (compact form is a Storybook design judgment — e.g. drops the thinking-level cell / abbreviates
   under width pressure or when many agents run). <!-- D-001 -->

2. **Live meter source.** <!-- D-002 --> Elapsed is derived live from the running link's event
   timestamp (free, no new data). `model` + `reasoningLevel` are **stamped onto
   `delegated.to{running}`** at spawn (they otherwise live only on the child session). Live output
   tokens are **mirrored from the child onto the parent link**, throttled and only while running.
   The row is therefore a pure function of the **parent** log — no always-on foreign-session
   subscription. Escape hatch: if the token mirror is too chatty, degrade to elapsed-only while
   running plus final tokens carried on the terminal fold-back link.

3. **Details view.** <!-- D-003 --> Clicking the row opens the **same** detail-takeover as other
   detail views (replaces the transcript, back button upper-left), rendering the **child session's
   live transcript** via the existing transcript row components. The web subscribes to the child
   session *on open only*, keyed by `childSessionId`.

4. **Support panel.** <!-- D-004 --> `runningSubagents` filters to `mode === "background"`. Inline
   agents no longer appear in the BACKGROUND group; the group is async-only.

Plus two cross-cutting touches:

5. **Turn-status line.** <!-- D-005 --> The pinned status drops the raw tool name; while an inline
   agent runs it reads `delegating to {agent}…` (projection in `derive.ts`'s
   `turnStatusHeaderFrom`), never `running delegate_inline`.

6. **Elapsed-timer drift.** <!-- D-006 --> The observed "seconds feel too fast" drift in the shared
   `useElapsedLabel` is reproduced, root-caused, and fixed; both the turn-status header and the new
   inline row read the corrected timer.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| `delegated.to` carries only `agent/task/mode/status/result` (`protocol.ts:600`) | Must extend the payload with optional `model`, `reasoningLevel`, and live `tokens` (backward-compatible optionals). |
| One assistant message can spawn several inline children (`loop.ts:1091`) | The transcript reducer must **group** parallel inline children by `parentRunId` into one block; the row layout must handle 1..N. |
| The transcript is built from the **current** session's log only | The row must not depend on a live child subscription; child data reaches the row via the parent link (stamped + mirrored). The details view is the only child-session subscription, and only while open. |
| Background/async delegation must keep working unchanged | Inline vs background is routed by `mode`; the existing purple block + BACKGROUND row stay for `mode:"background"`. |
| Token mirror must not bloat the parent log | Throttle (≈1/s or per child `assistant.progress` boundary), running-only; collapse to the single per-`childSessionId` block the reducer already maintains (`transcript.ts:493`). |

### Boundaries

- **Protocol** (`packages/session/src/protocol.ts`, `protocol-decode.ts`): extend the `delegated.to`
  payload with optional `model`, `reasoningLevel`, `tokens`. Backward compatible — absent fields
  render as today.
- **Host** (`apps/agent-host/src/agent/delegate.ts`): `seedChildSession` stamps `model` +
  `reasoningLevel` on the running link; a throttled token mirror folds the child's cumulative
  output tokens onto the same link while running; `foldBackLink` carries final tokens. Inline path
  only — background path unchanged.
- **Web read model** (`apps/web/src/transcript.ts`, `derive.ts`, `support-panel/support-panel.ts`):
  new `InlineAgentMessage` kind + parallel grouping by `parentRunId`; suppress the
  `delegate_inline`/`delegate_background` tool-call rows; `runningSubagents` mode filter; the
  `turnStatusHeaderFrom` headline for delegation.
- **Web render** (`apps/web/src/components/chat/`): new `InlineAgentRow` / `InlineAgentGroup`
  (Storybook-first, full + compact) replacing the inline branch of the delegation renderer; a new
  "agent" detail body in `tool-detail/` rendering the child transcript; the row's click → takeover
  wiring through `panel-host.tsx`.
- **Web hooks** (`apps/web/src/hooks/use-elapsed-label.ts`): the timer-drift fix.

New target files (`InlineAgentRow`, the agent detail body) get module-level comments describing what
they own and why they exist, matching the house style.

### Observability

The row *is* the observability surface for inline delegation (model, thinking level, elapsed, live
tokens at a glance; drill-in to the child's live transcript). The token mirror emits a structured,
throttled running update keyed by `childSessionId`; a failed/interrupted child keeps its existing
typed terminal link (`done`/`failed`/`interrupted`) so the row's terminal state stays truthful.

---

## Phases

### Phase 1: Web-only inline-agent surface (Storybook-first)

**Goal:** an inline delegation renders as one compact row (single) or an indented group (parallel),
distinct from tool cards, with full + compact variants — provable in Storybook before any protocol
change, using fixture data for model/thinking/tokens.

#### M1: InlineAgentRow / InlineAgentGroup component (presentational)

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Storybook story + test — a single running inline agent renders `agent · model · thinking · (elapsed · ↓ tokens)` as a bare row (no `└`), visually distinct from a tool-call row.
  2. GREEN: implement `InlineAgentRow` (presentational, props in), full variant.
  3. RED: story + test — parallel agents render under a header with the `└` tree-indent (reused from `tasks-panel.tsx:45`); 1 agent = no glyph, N = grouped.
  4. GREEN: implement `InlineAgentGroup` grouping + the shared indent helper.
  5. RED: story + test — status tones running/done/failed/interrupted, and the **compact** variant (design judgment: what the compact form drops/abbreviates).
  6. GREEN: implement tones + compact variant.
  7. REFACTOR: extract the shared glyph/indent helper with `tasks-panel`; module comment on the new file.

#### M7: Elapsed-timer drift fix (shared hook)

- **Dependencies:** none (grouped in Phase 1 because the row reuses the hook)
- **Effort:** S
- **Tasks:**
  1. RED: reproduce — a test asserting `useElapsedLabel` advances ~1s per real second; pin the actual cause (duplicate intervals across mounts, StrictMode double-invoke, non-monotonic `startedAt`, or render-driven reformat).
  2. GREEN: fix the drift at its root in the shared hook.
  3. REFACTOR: confirm both the turn-status header and the new inline row read the corrected timer; no double-ticking when both mount.

### Gate 1→2

- [ ] M1 + M7 stories and tests pass; inline row + group render from fixtures with full + compact variants; timer advances at wall-clock.

### Phase 2: Protocol + host live metadata

**Goal:** the parent log carries everything the row needs — `model`, `reasoningLevel`, live tokens —
for inline delegations, without a child subscription.

#### M2: delegated.to payload extension + host stamping/mirror

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: protocol test — `events.delegatedTo` accepts and round-trips optional `model`, `reasoningLevel`, `tokens`; decode test in `protocol-decode.ts`.
  2. GREEN: extend the `delegated.to` payload (optional, backward-compatible).
  3. RED: host test — `seedChildSession` stamps `model` + `reasoningLevel` from the child provider on the running link (inline only); background path unchanged.
  4. GREEN: wire the stamping in `delegate.ts`.
  5. RED: host test — while a child runs, a throttled token mirror emits `delegated.to{running, tokens}` with the child's cumulative output tokens; the terminal fold-back carries final tokens.
  6. GREEN: implement the throttled, running-only token mirror + final-token fold-back.
  7. REFACTOR: consolidate the mirror; assert no mirror for background children.

### Gate 2→3

- [ ] Protocol round-trips new fields; a real inline delegation stamps model/reasoning and streams throttled token updates on the parent log; background delegation byte-for-byte unchanged.

### Phase 3: Web wiring — projection, panel, status line, details

**Goal:** the real transcript renders the new row from live links, the chip is gone, inline leaves
the BACKGROUND panel, the status line is friendly, and the row drills into the child's live transcript.

#### M3: Transcript projection + tool-chip suppression

- **Dependencies:** M1, M2
- **Effort:** M
- **Tasks:**
  1. RED: `transcript.ts` test — a `delegated.to{mode:"inline"}` reduces to an `inlineAgent` message carrying `agent/model/reasoningLevel/tokens/startedAt/status`; parallel inline children from one `parentRunId` group into one block; running→terminal advances the same block (keyed by `childSessionId`, `transcript.ts:493`).
  2. GREEN: add `InlineAgentMessage` + the inline grouping in the reducer.
  3. RED: test — a `delegate_inline`/`delegate_background` tool call is **suppressed** from the transcript (no tool-card row); `mode:"background"` still renders the existing delegation block unchanged.
  4. GREEN: suppress the delegation tool-call rows; route inline→new row, background→existing block in `transcript-row-view.tsx`.
  5. REFACTOR: naming/dedupe; retire the inline branch of the old delegation renderer.

#### M4: Support panel — inline excluded from BACKGROUND

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: `support-panel` test — `runningSubagents` returns only `mode === "background"` children; a running inline child is absent; background children still present.
  2. GREEN: add the mode filter in `runningSubagents` (`support-panel.ts:142`); verify the `subagents` prop path in `app.tsx:607`.
  3. REFACTOR: update the panel doc comment (BACKGROUND = async only).

#### M5: Turn-status headline

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: `derive.ts` test — while an inline delegation runs, `turnStatusHeaderFrom` yields `delegating to {agent}…`, never `running delegate_inline`.
  2. GREEN: map the delegation tool to the friendly headline in the projection.
  3. REFACTOR: same friendly treatment at background-delegation start.

#### M6: Details view — child live transcript takeover

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: story/test — clicking an inline-agent row opens the detail-takeover (replaces transcript, back button upper-left) rendering the child session's transcript; a running child streams.
  2. GREEN: new "agent" detail surface; subscribe the web to the child session by `childSessionId` on open; render its transcript via existing row components; back restores the parent.
  3. RED: test — a done/failed/interrupted child detail shows the final transcript + result.
  4. GREEN: implement terminal detail + subscription teardown on close.
  5. REFACTOR: share the takeover chrome with the tool-detail takeover; module comment on the new detail body.

### Gate 3→done

- [ ] End-to-end in the running app: a real `delegate_inline` shows exactly one compact row (no chip, no purple block, not in BACKGROUND); the row's `(elapsed · ↓ tokens)` ticks at wall-clock; clicking it opens the child's live transcript with a back button; parallel inline agents group with `└`; background/async delegation is visually unchanged.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Token mirror bloats the parent log | medium | medium | Throttle (≈1/s or per child progress boundary), running-only, single per-`childSessionId` block; escape hatch to elapsed-only + final-tokens | host |
| Web can't cleanly subscribe to a child session for the details view | medium | medium | Scope the subscription to when the takeover is open; reuse `navigateToSession` plumbing (D-093) if in-place subscription is hard | web |
| Parallel-grouping edge cases (mixed running/terminal in one group) | low | medium | Reducer keyed by `childSessionId` already advances per child; test mixed states explicitly | web |
| Timer-drift root cause is environmental (StrictMode double-mount) not a real bug | low | medium | M7 starts with a reproduction test; if it's dev-only StrictMode, document and close rather than over-fix | web |

## Escape Hatches

1. **If the token mirror is too chatty:** drop live tokens; show elapsed-only while running and the final token count from the terminal fold-back link (`delegated.to{done}` carries child usage). Row contract otherwise unchanged. (References D-002.)
2. **If in-place child subscription is infeasible:** the details view falls back to `navigateToSession(childSessionId)` (full session switch, existing D-093 plumbing) instead of an in-transcript takeover. (References D-003.)

---

## Progress Report Accounting

See `progress-report.md`. Milestones are ordered by phase (M1, M7 in Phase 1; M2 in Phase 2; M3–M6
in Phase 3). The current focus marker tracks the first unchecked current-cutoff item. No deferred or
superseded buckets at authoring time.

## Validation Commands

```bash
# web unit + component tests
pnpm --filter @trevor/web test
# storybook (visual surfaces for M1/M6)
pnpm --filter @trevor/web storybook
# host + protocol tests
pnpm --filter @trevor/agent-host test
pnpm --filter @trevor/session test
# typecheck + lint
pnpm -w typecheck && pnpm -w lint
```

## Decisions

Canonical decisions are in `.plans/09.4-inline-agent-transcript/plan.db`. Query:

```bash
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "09.4-inline-agent-transcript"
```

Key decisions referenced above use `<!-- D-NNN -->` markers: D-001 (inline row), D-002 (live meter
source), D-003 (details view), D-004 (panel scope), D-005 (status line), D-006 (timer fix),
D-007 (numbering + non-goals).
