# Deepen — Implementation Plan

> Deepening audit of the Trevor V2 codebase (Ousterhout deep-modules discipline):
> shallow modules, leaky boundaries, and duplicated knowledge, captured as
> behavior-preserving refactors. Canonical decisions in `.plans/deepen/plan.db`
> (D-001…D-010). Source audit: `deepen` skill runs 1-3 (2026-06-24), scope
> `apps/agent-host` + `packages/session` + Trevor-authored `apps/web`. Run 1 →
> M1-M5 (data-flow + types); run 2 → M6-M8 (orchestration + web); run 3 → M9-M10
> (tool internals + confinement policy). The audit is converging — run 3's rejected
> set (bash-safety, stream-transport, TaskRegistry, ToolSection, system-prompt blocks,
> codex, SessionTransport) outweighs its finds.

## Architecture

These are **behavior-preserving** refactors that move duplicated/scattered knowledge
behind a single deeper boundary. None change the wire protocol's shape, the model's
prompt content, or user-visible behavior. Each milestone is independently shippable;
there is no hard ordering between them, but value/leverage sequences them M1→M5.

The throughline insight: the codebase already has one exemplar of the boundary we
want — the web's `toTranscript(events)` pure fold (transcript.ts). Several of the
findings are places where the **host** side does the same kind of work imperatively
(scattered mutation) or where the **same knowledge** (a schema, a payload shape, a
type) is spelled in multiple modules. The fix in each case is "one module owns it."

### Boundaries (target seams, justified by responsibility)

| Target seam | Owns | Why it exists |
|---|---|---|
| `agent-host/src/agent/history-projection` (new) | event-log → `ChatMessage[]` prompt view, the user/assistant pairing invariant, blank-completion filter, `/clear` reset | one pure, testable projection; the natural home for compaction's prompt-builder (trevor-v2 D-040) |
| `@trevor/session` breakdown category descriptor (new) | the canonical list of token-breakdown categories (key, pool, label, overhead-grouping) | host accumulation, wire type, and web treemap all derive from one source |
| `agent-host/src/tools/shared` `tryTool` (extend) | the `tryPromise` + `ToolExecutionError` wrapping contract | every tool's error mapping lives once |
| `@trevor/session` per-event codecs (restructure) | each event's payload shape (encode + decode together) | a payload shape lives in exactly one place |

### Observability

Behavior-preserving refactors — no new runtime/transport/provider behavior. The
contract is **existing tests stay green**; each milestone adds a characterization
test that pins current behavior before the extraction, so a regression is caught at
the seam rather than in production.

---

## Phases

### Phase 1: Deepening refactors (single phase, value-ordered)

**Goal:** duplicated/scattered knowledge in the four target seams is each owned by one
module, with no change to wire shape or user-visible behavior.

**Gate from previous:** none (greenfield audit follow-up).

#### M1: Host history projection <!-- D-001 -->

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Symptom / evidence:** info leakage + temporal decomposition. The event-log →
  `ChatMessage[]` projection is scattered as mutable state across `main.ts:67`
  (`let history`), `:281-296` (user-turn build + pairing), `:316-364` (`handleEvent`
  replay/live fold), `:361` (`/clear`). The web folds the *same* log with one pure
  function (`transcript.ts:100`, `toTranscript`); the host has no equivalent.
- **Proposed deeper boundary:** a pure `buildHistory(events): ChatMessage[]` module
  (mirroring `toTranscript`) owning mapping + pairing invariant + blank-filter +
  `/clear`. `main.ts` calls it instead of hand-mutating `history`.
- **Payoff:** `main.ts` reduces to orchestration; the projection is pure and testable;
  **it becomes the home for compaction's prompt-builder (trevor-v2 D-040)** — pins +
  summary substitution + recent-verbatim is one more case in this fold, not a sixth
  mutation site in `main.ts`.
- **Tasks:**
  1. RED: characterization test — feed a representative event sequence (user, assistant,
     tool round-trip, blank completion, `/clear`) and assert the exact `ChatMessage[]`
     the current `main.ts` mutation path produces.
  2. GREEN: extract `buildHistory(events)` reproducing that output; keep the pairing
     invariant + blank-filter inside it.
  3. RED: test `/clear` resets the projection mid-stream.
  4. GREEN: rewire `main.ts` replay + live paths to call `buildHistory`; delete the
     inline mutation sites.
  5. REFACTOR: add a module-level comment documenting what the projection owns; confirm
     the host turn loop is unchanged (16 host tests green).

#### M2: Token-breakdown category schema <!-- D-002 -->

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Symptom / evidence:** info leakage + repeated boilerplate. Category set enumerated
  ~6× in `usage/breakdown.ts` (`:27` type, `:60` ctor, `:73` seed, `:124` totals,
  `:144` session, `:162`/`:201` two log payloads), mirrored in `protocol.ts:36`
  (`UsageBreakdown`) and `web/breakdown.ts:31` (overhead derivation `:35`; leaves
  `:40-47` vs groups `:54-58` duplicated). Adding a category ≈ 8 edits.
- **Proposed deeper boundary:** one canonical category descriptor list
  (`{ key, pool: 'input'|'output', label, isOverhead }`) in `@trevor/session`; host
  accumulation/totals/logs, the wire type, and the web treemap/legend all derive from it.
- **Payoff:** adding/renaming a category is one edit; host, wire, and web cannot drift;
  ~120 lines of by-hand enumeration collapse.
- **Tasks:**
  1. RED: test that the host `snapshot()` and the web `panelBreakdown()` agree on the
     category set derived from the shared descriptor.
  2. GREEN: add the descriptor to `@trevor/session`; keep the wire `UsageBreakdown`
     shape unchanged (derive it from the descriptor).
  3. GREEN: rewrite `BreakdownAccumulator` + `logUsageBreakdown` to iterate the
     descriptor instead of naming fields.
  4. GREEN: rewrite web `breakdown.ts` to derive leaves + groups from the descriptor.
  5. REFACTOR: confirm the 5 host breakdown tests + the treemap stories render identically.

#### M3: Tool error-wrapping helper <!-- D-003 -->

- **Dependencies:** none
- **Effort:** S (1-3d)
- **Symptom / evidence:** repeated callsite boilerplate. 12 `Effect.tryPromise` +
  `ToolExecutionError({ tool: "<self>", … })` sites across 7 tools (edit ×3,
  multi-edit ×3, write ×2, glob/grep/read/web-search ×1), each re-spelling its name
  (e.g. `write.ts:32-39`).
- **Proposed deeper boundary:** a `tryTool(name, () => promise)` helper in
  `tools/shared.ts` wrapping `tryPromise` + `ToolExecutionError`; tools list operations,
  the error contract lives once.
- **Payoff:** tools shrink to their logic; one error contract; a tool cannot forget to wrap.
- **Tasks:**
  1. RED: test `tryTool` maps a thrown error to a `ToolExecutionError` carrying the tool name.
  2. GREEN: add the helper to `tools/shared.ts`.
  3. GREEN: swap all 12 callsites across the 7 tools.
  4. REFACTOR: confirm tool execution + the `error:` rendering path (`executeTool`) unchanged.

#### M4: Protocol per-event codecs <!-- D-004 -->

- **Dependencies:** none
- **Effort:** L (1-2w)
- **Symptom / evidence:** info leakage / dual-maintenance. Each event's payload keys are
  spelled twice — the `events.*` builder and the matching `decodeTrevorEvent` case —
  across ~15 events, synced by hand; this doubling is ~half of `protocol.ts`'s 635 lines.
- **Proposed deeper boundary:** per-event codec objects `{ type, encode, decode }`, one
  per event; `events` and `decodeTrevorEvent` derive from the codec list so a payload
  shape lives in one place.
- **Payoff:** adding/changing an event is one edit; encode and decode cannot drift.
- **Note:** higher churn (restructures the protocol core) and lower priority — the file
  is at least already the single source of the protocol. Do behind the existing decode
  tests; defer until M1-M3 land.
- **Tasks:**
  1. RED: round-trip test — every event built by `events.*` decodes back to the same typed shape.
  2. GREEN: introduce the codec object form for 2-3 events; keep `events`/`decodeTrevorEvent`
     as derived maps.
  3. GREEN: migrate the remaining events incrementally, round-trip test green throughout.
  4. REFACTOR: remove the hand-written builder/decoder pairs.

#### M5: Usage type de-duplication <!-- D-005 -->

- **Dependencies:** none
- **Effort:** S (<1d)
- **Symptom / evidence:** info leakage. `Usage { input, output, contextWindow, genMs }`
  declared verbatim in `providers/types.ts:45` and `protocol.ts:21`.
- **Proposed deeper boundary:** host imports the wire `Usage` from `@trevor/session`,
  or a one-line note documents the deliberate internal/wire decoupling.
- **Payoff:** small; flagged for completeness — decide dedup vs documented-decoupling.
- **Tasks:**
  1. GREEN: import the wire `Usage` in `providers/types.ts` (or add the decoupling note).
  2. REFACTOR: typecheck host + web clean.

#### M6: Turn scheduler <!-- D-006 --> (round 2)

- **Dependencies:** M1 (extract the history projection first, so projection and scheduling separate cleanly)
- **Effort:** M (3-7d)
- **Symptom / evidence:** temporal decomposition / mixed concerns. The "when do turns
  run" machine is spread through `main.ts` module mutables (`activeRun`,
  `deferredUserEvents`, `lastUserEvent`/`lastAnswerSeq`) and free functions —
  `respondTo` (:161, lease/activeRun gating + fiber lifecycle :185-194),
  `handleUserMessage` (:272, record-or-defer :277-279), `drainDeferred` (:301), the
  leader catch-up (`onBecomeLeader` :199) — interleaved with connection, lease, and presence.
- **Proposed deeper boundary:** a `TurnScheduler` owning `{activeRun, deferred queue,
  run lifecycle}` behind `submit(userMessage)` / `onComplete(runId)` / `isBusy()` /
  `drain()`. `main.ts` wires transport + lease to it and stops hand-managing run state.
- **Payoff:** the one-turn-at-a-time invariant + deferred FIFO + leader catch-up become
  one testable unit; **with M1 this leaves `main.ts` as pure wiring** (connect + lease +
  emit). Distinct from M1: M1 is *what the model sees*, M6 is *when turns run*.
- **Tasks:**
  1. RED: characterization — submit while busy defers; `onComplete` drains the next; a
     second prompt mid-turn never overlaps; consecutive abandoned user turns collapse.
  2. GREEN: extract `TurnScheduler` owning the run state + queue.
  3. GREEN: rewire `respondTo`/`handleUserMessage`/`drainDeferred`/`onBecomeLeader` to it.
  4. REFACTOR: `main.ts` retains only transport/lease/presence wiring; host tests green.

#### M7: Web send-queue / steering hook <!-- D-007 --> (round 2)

- **Dependencies:** none
- **Effort:** M (3-7d)
- **Symptom / evidence:** mixed concerns. A self-contained queue+drain+steer machine is
  inline in the 1023-line `App.tsx`: `QueuedPrompt` + `combineSteer` (:80) + `queue`/
  `setQueue` (:299) + `inFlightRef` + the drain effect (:402-412) + `onSubmit` enqueue
  (:330) + the hard-steer fold (:421-426), tangled with rendering, provider selection,
  the slash menu, and uploads.
- **Proposed deeper boundary:** a `useSendQueue({ busy, publish, cancel })` hook (or plain
  reducer module) owning the queue, the drain rule, and the steer-fold. `App.tsx`
  consumes `{ submit, steer, queued }` and renders.
- **Payoff:** the queue/steer logic is unit-testable without React rendering; the
  fold-on-steer rule has one home; `App.tsx` shrinks toward composition.
- **Tasks:**
  1. RED: reducer test — enqueue while busy, drain when idle, steer folds queue+draft+artifacts into one.
  2. GREEN: extract the hook/reducer.
  3. GREEN: rewire the composer + ESC-steer in `App.tsx` to it.
  4. REFACTOR: web typecheck clean; behavior unchanged.

#### M8: Provider roster (shared) <!-- D-008 --> (round 2)

- **Dependencies:** none
- **Effort:** S (<1d)
- **Symptom / evidence:** info leakage. Roster + labels + `reasoningLevels` +
  `defaultReasoning` spelled in both `providers/index.ts:29-48` and web
  `derive.ts:190-211` (`FALLBACK_MODELS`); adding/renaming a provider edits both. (The
  web list is a pre-`host.online` fallback — partly intentional.)
- **Proposed deeper boundary:** a `DEFAULT_PROVIDER_MODELS` const in `@trevor/session`
  imported by both host and web.
- **Payoff:** roster changes are one edit; the pre-announce UI can't drift from the host.
- **Tasks:**
  1. GREEN: add `DEFAULT_PROVIDER_MODELS` to `@trevor/session`.
  2. GREEN: import it in host `providers/index.ts` defaults and web `derive.ts`.
  3. REFACTOR: host + web typecheck clean.

#### M9: edit / multi_edit shared matching core <!-- D-009 --> (round 3)

- **Dependencies:** none (composes with M3's `tryTool`, but independent)
- **Effort:** S (1-3d)
- **Symptom / evidence:** info leakage + thin wrapper. `edit.ts:39-48` and
  `multi-edit.ts:96-104` each reimplement "count occurrences of `old` (0 → not found,
  >1 → ambiguous), then replace", plus the same confine + read + write +
  `ToolExecutionError` dance. `edit` is essentially `multi_edit` with one item.
- **Proposed deeper boundary:** a shared `applyUniqueReplacement(content, old, new)`
  (returns new content or a typed miss); `edit` becomes the single-item case of the
  `multi_edit` core. Match semantics + the not-found/ambiguous messages live once.
- **Payoff:** changing match semantics (e.g. whitespace-tolerant anchors) is one edit;
  `edit` shrinks to a thin adapter; consistent error wording.
- **Tasks:**
  1. RED: matcher test — unique replace, not-found, ambiguous (>1).
  2. GREEN: extract `applyUniqueReplacement`.
  3. GREEN: rewire `edit` + `multi_edit` to the shared core (+ M3's `tryTool` if landed).
  4. REFACTOR: confirm both tools' outputs unchanged.

#### M10: Workspace-confinement as a single policy <!-- D-010 --> (round 3)

- **Dependencies:** none
- **Effort:** S-M (2-5d)
- **Symptom / evidence:** info leakage / leaky boundary. The confined tool set is tacit
  (which tools import `confine()` — edit/multi-edit yes; read/write/bash no), and the
  rule is stated twice near-verbatim in `system-prompt.ts` (`:28`
  `TOOL_SELECTION_GUIDANCE`, `:76` `executionContext`). Prose and enforcement can drift —
  the prompt lists glob/grep as confined though they do not route through `confine()`.
- **Proposed deeper boundary:** own the confinement policy as data in `tools/workspace.ts`
  (the workspace-confined tool set + the rule); per-tool enforcement and the
  system-prompt confinement line both derive from it.
- **Payoff:** one source for "which tools are workspace-confined"; the prompt cannot
  claim a confinement the tools don't enforce; the two prose duplicates collapse to one
  generated line.
- **Note:** this audit surfaced a likely prompt/enforcement drift (glob/grep); the fix is
  part of the redesign, not this read-only audit.
- **Tasks:**
  1. RED: test the policy — `isConfined(tool)` matches the set the prompt advertises.
  2. GREEN: define the policy descriptor + confined set; route enforcement through it.
  3. GREEN: generate the prompt's confinement line from the descriptor; delete the two prose duplicates.
  4. REFACTOR: reconcile glob/grep enforcement with the advertised policy.

### Gate (phase complete)

- [ ] All existing host tests (≥16) + web typecheck green after each milestone
- [ ] No change to wire payload shapes or the model's prompt content
- [ ] M1's `buildHistory` is referenced by the trevor-v2 D-040 compaction prompt-builder
- [ ] After M1 + M6, `main.ts` is connection + lease + emit wiring only

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| M1 changes prompt content subtly (reorders/drops a message) | high | low | characterization test pins exact `ChatMessage[]` before extraction |
| M2 changes the wire `UsageBreakdown` shape, breaking older logged events | medium | low | derive the wire type from the descriptor; keep field names identical |
| M4 large surface, partial migration leaves two styles | low | medium | incremental per-event migration with round-trip test green throughout; defer until last |
| M6 scheduler extraction changes turn dispatch timing/ordering | high | low | characterization test pins defer/drain/collapse behavior before extraction; do after M1 |
| M7 hook extraction changes send/steer UX (queue order, ESC fold) | medium | low | reducer test pins enqueue/drain/steer-fold; manual ESC-steer smoke |

---

## Escape Hatches

1. **If M4 churn outweighs payoff:** stop after M1-M3; leave the protocol codec pairs as-is
   (the file is already the single source) and close D-004 as accepted-as-is.
2. **If M5 is intentional decoupling:** replace the dedup with a documented note and close D-005.

---

## Decisions

Canonical decisions are in `.plans/deepen/plan.db` (D-001…D-005). Query:

```bash
mise x node@22 -- ~/.agents/skills/planner/scripts/node_modules/.bin/tsx \
  ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan deepen
```
