# Live Output Scroll Parity - Implementation Plan

## 0. Hard Dependencies

- [x] Main transcript scroll-follow fixes are merged to `main`: `useScrollFollow`,
  `createScrollFollowController`, and `VirtualTranscript` now define bottom-follow, unpin, explicit
  jump-to-bottom, and visual-anchor preservation for the primary transcript.
- [x] Tangent takeover exists and is live: `LiveTangentShell` binds a tangent session and
  `TangentShell` renders the tangent conversation in the center-column takeover.
- [x] Delegated subagent detail exists and is live: `LiveAgentDetail` binds the child session and
  `AgentDetailShell` renders the child transcript rows in a read-only takeover.
- [x] Tool/job detail exists and is live: transcript tool/shell rows and promoted background jobs both
  render through `ToolDetailView` and update from live model snapshots.
- [x] Downstream accommodation - none. No numbered plan higher than `58.3` exists on `main`; the local
  `fix/streaming-scroll-anchor` branch is a stale source branch, not a live numbered plan branch.

## 1. Architecture

The main transcript is currently the only surface with the full scroll-follow contract: a stable
`useScrollFollow` controller, `VirtualTranscript` write arbitration, visual-anchor preservation while
unpinned, an explicit jump-to-bottom affordance, and browser-test instrumentation. Other live-output
takeovers have partial copies of that behavior:

- Tangent uses `useScrollFollow(turns.length)` but renders a lightweight custom list in
  `apps/web/src/tangent/tangent-shell.tsx`, so it does not share the main transcript's append and
  streaming-growth anchor behavior.
- Delegated subagent detail uses the same transcript projection (`toTranscript` / `buildTranscriptRows`)
  and row renderer (`TranscriptRowView`), but `AgentDetailShell` has its own non-virtual scroll state,
  direct `scrollTop = scrollHeight`, and local arrow.
- Tool/job detail output renders through `ToolDetailView`, which uses a plain `overflow-y-auto` body.
  Running tool/shell detail and promoted background job detail can update while open, but they have no
  shared bottom-follow or unpinned-anchor contract.

The fix is to define one reusable **live scroll surface** contract, then apply it to every live,
append/stream output takeover that needs transcript-like behavior: tangent, delegated subagent detail,
and tool/job detail output. Ordinary static overflow panels, menus, archives, diagnostics, and bounded
browsing lists stay out of scope. <!-- D-004 -->

The target shape is a shared browser-side primitive that owns:

- the scroll container ref and directional user-gesture wiring;
- the controller-gated "follow only while pinned" policy;
- visual-anchor preservation while unpinned, including streaming text/output growth;
- the explicit jump-to-bottom affordance contract;
- optional unseen-content state;
- test hooks for scroll metrics used by browser verification.

`VirtualTranscript` remains the owner for virtualized transcript rows. Smaller takeovers should use a
non-virtual implementation backed by the same controller semantics unless a real performance fixture
shows virtualization is needed. The invariant is that no surface introduces its own bottom-follow state
machine once the shared live-scroll surface exists. <!-- D-001 --> <!-- D-004 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| User reading position wins over live output | Once unpinned, new tangent turns, child transcript rows, and growing tool/job output preserve the visible anchor instead of pushing content upward. |
| Bottom-follow parity with main transcript | If already at the bottom, new live output follows the live edge; if not, it appends/grows without moving the viewport. |
| Explicit re-entry only | Re-enter bottom-follow mode only when the user scrolls near the bottom or clicks the jump-to-bottom arrow. <!-- D-003 --> |
| Virtualization remains opt-in | Delegated subagent detail can stay non-virtualized until a child transcript has enough rows or measured jank to justify `VirtualTranscript`. |
| Tangent identity is obvious | The tangent header gets a bright `TANGENT` badge, while transient running copy becomes `Working...`. <!-- D-002 --> |

### Boundaries

```
apps/web/src/scroll-follow.ts
  Existing pure pin/write-arbitration controller. Reuse; do not fork.

apps/web/src/hooks/use-scroll-follow.ts
  Existing React adapter. Extend only if every live-output surface benefits.

apps/web/src/components/chat/
  Shared live-scroll component/hook lives here if it is transcript/chat-generic.
  VirtualTranscript continues to own virtualized row measurement.

apps/web/src/tangent/
  LiveTangentShell supplies tangent turn data and the shared scroll wiring.
  TangentShell owns tangent-specific header/composer/fold-back UI only.

apps/web/src/agent-detail/
  LiveAgentDetail owns child-session projection.
  AgentDetailShell owns delegated-agent chrome and row rendering only; scroll policy moves to the shared primitive.

apps/web/src/tool-detail/
  ToolDetailView owns detail chrome and body dispatch only; live output body scrolling uses the shared primitive.

apps/web/src/support-panel/
  jobToDetailModel continues projecting promoted jobs into ToolDetailModel; no scroll policy lives here.
```

### Observability

Add deterministic browser-test instrumentation for every covered live-output scroller, matching the
metrics used to prove the main transcript fix: `scrollTop`, `scrollHeight`, `clientHeight`, bottom
distance, visible item ids where applicable, pinned/at-bottom state, and the last denied controller
write when exposed in development. This is test-only/debug state surfaced through DOM data attributes or
a scoped browser test helper, not user-facing UI.

---

## 2. Phases

### Phase 1: Shared Live-Scroll Primitive

**Goal:** Main transcript semantics are available to non-virtual live-output surfaces without copying
bottom-follow logic.

**Gate from previous:** Existing main transcript scroll-follow tests are green.

#### M1: Characterize non-virtual live-output scroll behavior

- **Dependencies:** none
- **Effort:** M
- **Tasks:**
  1. RED: Add a focused web/component characterization proving a non-virtual live-output surface at
     bottom follows when a new item is appended.
  2. RED: Add a focused web/component characterization proving the same surface preserves `scrollTop`
     and visible item id when unpinned and a new item is appended.
  3. RED: Add a focused web/component characterization proving streaming text/output growth preserves
     the visible anchor while unpinned.
  4. GREEN: Extract or introduce the smallest shared live-scroll surface that passes those
     characterizations by reusing `createScrollFollowController` and `useScrollFollow`.
  5. REFACTOR: Keep `VirtualTranscript`'s existing behavior intact while sharing only the reusable
     controller/DOM surface contract.

#### M2: Replace local bottom-follow copies in consuming surfaces

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a test proving the shared scroll-to-bottom arrow is visible when a covered surface is
     unpinned and hidden when pinned. <!-- D-003 -->
  2. GREEN: Move the jump-to-bottom button and unseen-content presentation into the shared live-scroll
     surface, preserving the main transcript's visual states where they apply.
  3. RED: Add a test proving passive incoming updates do not re-pin after the user has scrolled up.
  4. GREEN: Replace each covered surface's local `atBottom`, direct `scrollTop = scrollHeight`, and local
     arrow with the shared primitive.
  5. REFACTOR: Make surface-specific components own only their domain chrome and content rendering.

### Gate 1->2

- [ ] Main transcript scroll tests still pass unchanged.
- [ ] Shared non-virtual live-scroll component tests prove append and streaming growth preserve the
      viewport while unpinned.
- [ ] No covered surface has a tangent/agent/tool-specific bottom-follow state machine.

### Phase 2: Covered Surface Integration

**Goal:** Tangent, delegated subagent detail, and tool/job detail output all consume the shared
live-scroll primitive.

#### M3: Tangent integration and UX polish

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add/extend tangent shell tests proving at-bottom follow, unpinned anchor preservation, and
     scroll-to-bottom arrow behavior.
  2. GREEN: Wire `TangentShell` to the shared live-scroll surface; `LiveTangentShell` supplies only the
     shared scroll state and tangent turn data. <!-- D-001 --> <!-- D-004 -->
  3. RED: Add a tangent shell test or story assertion for a bright `TANGENT` badge in the header. <!-- D-002 -->
  4. GREEN: Replace the muted text-only header label with a brighter `TANGENT` badge and change the busy
     shimmer label from `Working in the tangent` to `Working...`. <!-- D-002 -->
  5. REFACTOR: Keep tangent-specific rendering limited to header, source quote, turn row, fold-back, and
     composer concerns.

#### M4: Delegated subagent detail integration

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add `AgentDetailShell` tests proving child transcript append follows only when pinned and
     preserves the visible row while unpinned.
  2. GREEN: Replace `AgentDetailShell`'s local `useBoolean(atBottom)`, `scrollRef`, direct scroll writes,
     and local arrow with the shared live-scroll surface.
  3. RED: Add a test proving streaming child output growth uses the same revision signal without forcing
     a reader back to the bottom.
  4. GREEN: Keep delegated detail non-virtualized but controller-backed; do not introduce
     `VirtualTranscript` unless a performance fixture requires it.
  5. REFACTOR: Keep `LiveAgentDetail` as projection-only (`toTranscript` / `buildTranscriptRows`) and
     keep `AgentDetailShell` as read-only chrome plus row rendering.

#### M5: Tool and promoted-job detail integration

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add `ToolDetailView` tests proving growing shell/tool output follows only when pinned and
     preserves manual reading position while unpinned.
  2. GREEN: Wrap the live detail body/output region in the shared live-scroll surface without changing
     `DetailBody` dispatch semantics.
  3. RED: Add a promoted-job detail test proving live `job.tail` updates behave like running shell output.
  4. GREEN: Keep `jobToDetailModel` projection unchanged; the scroll policy belongs in `ToolDetailView`.
  5. REFACTOR: Ensure static tool details do not show unnecessary jump controls when content does not
     overflow.

### Gate 2->3

- [ ] Tangent has the shared jump arrow, `TANGENT` badge, and `Working...` copy.
- [ ] Delegated subagent detail uses the shared live-scroll primitive and remains non-virtualized.
- [ ] Tool detail and promoted-job detail share the same live-output scroll behavior.
- [ ] No unrelated transcript row styling changes are included.

### Phase 3: Browser Verification

**Goal:** End-user-like browser evidence proves every covered live-output surface follows at bottom and
preserves user reading position while unpinned.

#### M6: Deterministic browser reproduction and regression coverage

- **Dependencies:** M3, M4, M5
- **Effort:** M
- **Tasks:**
  1. RED: Add deterministic browser scenarios for tangent, delegated subagent detail, and tool/job detail
     with enough mixed-height content to overflow each scroll well.
  2. GREEN: Instrument those scenarios to capture `scrollTop`, `scrollHeight`, `clientHeight`, bottom
     distance, visible item ids where applicable, and pinned/at-bottom state before and after
     append/stream actions.
  3. RED: Assert that while unpinned, appending new items and growing streaming output do not change the
     visible anchor beyond a small pixel tolerance.
  4. GREEN: Make the browser scenarios pass using the shared live-scroll surface.
  5. REFACTOR: Align the browser helper names with existing transcript scroll tests so future main,
     tangent, agent-detail, and tool/job-detail scroll regressions share fixtures.

### Final Gate

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] Relevant `pnpm test --project web` tests for live-scroll, tangent, agent-detail, and tool-detail behavior.
- [ ] Browser E2E live-output reproduction showing before/after scroll metrics for at-bottom follow and
      unpinned anchor preservation across tangent, delegated subagent detail, and tool/job detail.
- [ ] Manual visual check confirms the `TANGENT` badge and shared scroll-to-bottom arrow are legible in
      each covered takeover.

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Non-virtual surfaces need different anchor detection than `VirtualTranscript` | medium | medium | Extract the shared policy at the scroll-surface level, not at the virtualizer implementation level. | implementer |
| Tool detail has static and live use cases | medium | medium | Keep jump controls conditional on overflow/unpinned state and avoid changing `DetailBody` content semantics. | implementer |
| Browser tests become flaky around pixel tolerances | medium | medium | Use deterministic content, fixed viewport sizes, visible ids where available, and bounded pixel deltas. | implementer |
| The existing local arrows appear to satisfy the request while behavior remains divergent | high | medium | Treat arrows as part of shared scroll-state parity and verify append/stream behavior mechanically. | implementer |

---

## Escape Hatches

1. **If adapting tangent into `VirtualTranscript` adds unnecessary row-model churn:** keep tangent rows
   lightweight and use the shared non-virtual scroller.
2. **If delegated child transcripts become large enough to justify virtualization:** add a measured
   performance fixture first; then consider a `VirtualTranscript`-backed child detail path.
3. **If tool detail output has no stable item ids:** preserve raw scroll offset plus bottom distance for
   output-growth cases and use visible text probes only in browser tests.
4. **If a browser-tools integration is unavailable:** use Playwright for deterministic browser scenarios,
   matching the existing browser E2E approach.

---

## Progress Report Accounting

The progress report is the implementation resume state. Before implementation resumes or convergence is
declared, run:

```bash
npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.3-tangent-transcript-scroll-parity"
```

---

## Validation Commands

```bash
pnpm lint
pnpm typecheck
pnpm test --project web
pnpm test:e2e:browser -- tests/browser/transcript-scroll.spec.ts
```

Before starting a dev server for browser verification, read repo-relevant `AGENTS.md` files and
`~/.agents/PORTS.md`, then use the registered Trevor web port.

---

## Decisions

Canonical decisions are in the plan database (`.plans/58.3-tangent-transcript-scroll-parity/plan.db`).
Query with:

```bash
npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "58.3-tangent-transcript-scroll-parity"
```
