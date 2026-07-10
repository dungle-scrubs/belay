# Assistant-UI Audit Research Spikes - Implementation Plan

## 0. Hard Dependencies

- [x] Plan 58.6 (assistant-ui pattern audit) complete; these are its deferred
  measurement (D2) and Track B (E4/A14/A16/A17/E8) investigations. <!-- D-001 -->
- [ ] Forward constraint (not a blocker): Track B (M2/M3) touches the
  `SessionTransport` seam owned by live plan 50. These spikes are read-only /
  Storybook-side, so they proceed now; any FOLLOW-UP proposing a transport-visible
  contract must sequence after/with plan 50. <!-- D-003 -->

## 1. Objective

Answer three open questions from the audit with measurement, not opinion. Every
milestone is research-only (58.6 D-002): it ends in a benchmark or findings document
plus a go/no-go decision for a *future* plan. Nothing here adopts assistant-ui, changes
a wire contract, or touches the durable log. <!-- D-002 -->

## 2. Relevant Surfaces (verified)

- **D2:** `apps/web/src/markdown.tsx:129` `markdownParts(text, mermaid)` re-lexes +
  re-sanitizes the whole message; called at `:187` on `deferredText` (`useDeferredValue`
  at `:179`), so every settled streaming frame re-parses the entire message.
  `@assistant-ui/react-markdown`'s Streamdown does block-incremental parsing.
- **E4/A14:** `apps/web/src/transcript.ts:1218` `toTranscript(...)` and
  `apps/web/src/session/projection.ts:74` `createSessionReadModel(...)` /
  `SessionReadModel` (`:35`) are the read model an ExternalStore adapter would mirror.
- **A16/A17/E8:** Trevor's event taxonomy (compaction, delegation, tangent, hook,
  limits row kinds) is the projection source whose lossiness into
  `{id,parent_id,format,content}` M3 measures.

## 3. Milestones

### M1: Streaming-markdown re-lex profiling gate (D2)

**Testing:** test-after (performance spike; the deliverable is a measurement + a
go/no-go decision, not shipped code).

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Define the benchmark + pass criteria - e.g. a 20KB message streamed in
     realistic deltas; measure per-frame `markdownParts` CPU (lex + DOMPurify) at
     several message lengths (2KB / 8KB / 20KB / 50KB). State the threshold at which
     whole-text re-lex cost would justify a second engine's bundle.
  2. GREEN: Build a throwaway benchmark harness (Storybook story or a profiling
     script) driving `markdownParts` / `MarkdownBody` over the delta sequence; record
     numbers.
  3. GREEN: Compare against Streamdown's incremental parse (measured or, if not cheaply
     runnable, its documented complexity) and its bundle delta.
  4. Decision: record adopt-Streamdown / incremental-parse-in-place / keep-as-is with
     the measured evidence. Close or open a follow-up plan accordingly.

### M2: Read-only ExternalStore adapter spike (E4/A14)

**Testing:** test-after (Storybook spike; measurement + findings, no production wiring).

- **Dependencies:** none (coordinates with plan 50 only if it graduates - D-003)
- **Effort:** M
- **Tasks:**
  1. RED: Define what "cheaper or not" means - the render-cost comparison (assistant-ui
     Thread/Message primitives fed by an ExternalStore adapter over one session's
     `toTranscript` output vs Trevor's bespoke rows) and the correctness checks
     (thread-id sync, immutability discipline).
  2. GREEN: Build a Storybook-only read-only `ExternalStore(ThreadList)Adapter` mirroring
     the `SessionReadModel` for ONE captured session; no intents wired.
  3. GREEN: Measure render cost vs the current transcript rows; document the
     thread-id-sync footgun and useShallow re-render behavior observed.
  4. Decision: record whether the adapter is a viable bridge to assistant-ui primitives
     (keeping the durable log sole source of truth) or just a converter plus a sync
     hazard. Feeds M3.

### M3: Persistence / thread-adapter mapping study (A16/A17/E8)

**Testing:** test-after (analysis spike; findings doc).

- **Dependencies:** M2 (uses the same adapter framing)
- **Effort:** S-M
- **Tasks:**
  1. RED: Enumerate every Trevor transcript-row / event kind (compaction, delegation,
     tangent, hook, limits, tool, reasoning, ...) and the target
     `{id,parent_id,format,content}` shape; define "lossless" vs "lossy view."
  2. GREEN: Map each kind to the adapter shape; flag which need custom data parts and
     which have no representation. Check the initialize-before-first-append race guard
     on Trevor's session-create path.
  3. Decision: record whether an adapter is a true bridge or a lossy view, and the
     concrete losses - the input any future ExternalStore adoption plan needs.

## 4. Non-Goals

- No adoption of Streamdown, ExternalStoreRuntime, or any assistant-ui runtime.
- No change to `toTranscript`, the session read model, the transport, or the durable log.
- No new transport-visible contract (that would gate on plan 50).
- No production wiring of the Storybook adapter.

## 5. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Benchmark not representative of real streaming | medium | medium | M1 RED fixes realistic delta cadence + multiple lengths before measuring | impl |
| Spike quietly grows into production wiring | medium | low | D-002 non-goal; M2/M3 are Storybook/analysis only, exit is a decision | impl |
| Adapter render-cost win is illusory (converter overhead) | medium | medium | M2 measures against real rows, not assumptions | impl |
| Findings ignored later | low | medium | Each milestone ends in a recorded plan-db decision usable by a future plan | impl |

## 6. Validation Commands

```sh
pnpm --filter web test
pnpm --filter web build   # bundle-delta check for the D2 Streamdown comparison
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.6.3-audit-research-spikes"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58.6.3-audit-research-spikes" --streak 3
```

## 7. Decisions

Canonical decisions are in `plan.db`.

- D-001: research spikes deferred from the 58.6 audit (D2 + Track B).
- D-002: research-only; every milestone exits in a measurement + go/no-go decision.
- D-003: Track B is read-only/Storybook now; a transport-visible follow-up gates on plan 50.
- D-004: numbered 58.6.3.
