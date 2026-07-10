# Assistant-UI Audit Follow-Ups - Implementation Plan

## 0. Hard Dependencies

- [x] Plan 58.6 (assistant-ui pattern audit) is complete; its deliverable
  `assistant-ui-opportunities.md` (repo root) is the source of these follow-ups. <!-- D-001 -->
- [x] Plan 58.4 (assistant-ui thread virtualization) is complete and shipped as the Trevor-owned
  virtual transcript (`apps/web/src/components/chat/virtual-transcript.tsx`, commit `ed835a97`).
  Per 58.6 D-001 all scroll/virtualization decisions route there. <!-- D-004 -->
- [x] 58.6 D-002 holds: Trevor's durable session log, Tether transport, host turn loop, and
  transcript projection remain the source of truth. This plan is web-side only; it changes no
  wire contract. <!-- D-005 -->

## 1. Objective

Land the three accepted adopt/adapt follow-ups from the 58.6 audit that are self-contained,
web-side, and carry local evidence: <!-- D-001 -->

1. **Prune the dead assistant-ui markdown stack** (audit row D1) - delete an idle-preloaded second
   markdown pipeline that never renders live, shrinking startup work and the dependency surface.
2. **Running-tool elapsed clock** (audit row F6) - show a live elapsed timer on running tool rows so
   a slow tool is distinguishable from a stuck one.
3. **assistant-ui dependency governance** (audit rows E10/G8/G9/D6/C7) - exact version pins, a
   stability ledger in `CONTEXT.md`, a vendored-component drift check, and render smoke tests that
   survive version bumps; retires the audit's "unstable API churns after adoption" risk.

Two audit items were deliberately dropped and are recorded so they are not reopened as vague
follow-ups:

- **Item 4, structured MCP result rows** - dropped. The host `mcp` tool contract returns
  `Effect<string, ToolError>` (`apps/agent-host/src/mcp/runtime.ts:37`) and flattens its structured
  records (`McpResourceContext`, `McpServerStatusEntry`) to bounded text by design. A per-server
  table therefore needs either a tool-result contract change (guarded by 58.6 D-002) or fragile
  string re-parsing - neither is presentational. Revisit only as a separate read-only MCP
  status-panel plan over `statusSnapshot()`, if a real need appears. <!-- D-003 -->
- **Item 5, content-visibility paint-skipping** - dropped, superseded by 58.4. The virtual
  transcript already unmounts off-screen rows above 128 (visible range + 40 overscan via
  `@tanstack/react-virtual`), so on a 500-row session there is nothing off-screen to paint-skip; it
  could only touch the ~80 overscan rows and would fight the virtualizer's `measureElement`
  (double-hiding). <!-- D-004 -->

## 2. Relevant Surfaces (verified)

### Item 1 - dead markdown stack (all under `apps/web/src/components/assistant-ui/`)

- `thread.tsx` - the linchpin; **zero importers anywhere in the repo**. Reaches the dead stack.
- `markdown-text-lazy.tsx:12` - `preloadOnIdle` warms `markdown-text.tsx` on idle; the only mount
  sites are the dead `thread.tsx:357` and dead `reasoning.tsx:315`.
- `markdown-text.tsx` - the second markdown stack (`@assistant-ui/react-markdown` +
  `remark-gfm` + `dot.css`). Only importer is `markdown-text-lazy.tsx:12`.
- `reasoning.tsx` - **partially live**: `ReasoningImpl`/`Reasoning` (`:315`, `:351`) are dead;
  `ReasoningGroup`/`reasoningVariants` are LIVE via `chat/reasoning-trace.tsx:3`, and that live path
  renders `<MarkdownBody>` (the `marked` stack), never `MarkdownText`.
- Live markdown (assistant text and reasoning text) renders through `src/markdown.tsx` /
  `MarkdownBody` (`chat/transcript-row-view.tsx:12`, `chat/reasoning-trace.tsx:84`).
- `package.json:39` `remark-gfm` - sole use is `markdown-text.tsx:11`; removable entirely.
- `package.json:19` `@assistant-ui/react-markdown` - after the prune, its only reference is a
  type-only import in the live `diff-viewer.tsx:4` (`SyntaxHighlighterProps`); drops to type-only.

### Item 2 - running-tool elapsed clock

- `apps/web/src/transcript.ts:63` - `ToolMessage` type; carries no timestamp today.
- `apps/web/src/transcript.ts:1020-1057` - the `tool.started` fold; builds `ToolMessage` from the
  payload, reads neither `event.createdAt` nor `event.seq`.
- `packages/session/src/event.ts:15-23` - every `SessionEvent` envelope already carries
  `createdAt` (ISO) and `seq`. The precedent conversion is `Date.parse(event.createdAt)`.
- `apps/web/src/transcript.ts:925-937` - the exact precedent: `InlineAgent.startedAt` sourced via
  `Date.parse(event.createdAt)` with a `NaN` guard.
- `apps/web/src/hooks/use-elapsed-label.ts:22` - `useElapsedLabel(startedAt?: number)`; ticks 1/s,
  pauses on `undefined`.
- `apps/web/src/components/chat/action-shimmer.tsx` - `ActionShimmer` accepts `startedAt?: number`
  and feeds `useElapsedLabel`; the running row already renders it WITHOUT a start
  (`chat/status-aware-tool-renderer.tsx:70`).
- `apps/web/src/components/chat/inline-agent-row.tsx:54` - the consumer precedent
  (`useElapsedLabel(running ? agent.startedAt : undefined)`).

### Item 3 - governance

- `apps/web/package.json:18-19` - caret ranges `^0.14.23` / `^0.14.4` to replace with exact pins.
- `apps/web/src/components/assistant-ui/` - 21 vendored files (the drift-check surface).
- `CONTEXT.md` (202 lines) - home for the stability ledger table.

## 3. Milestones

### M1: Prune the dead assistant-ui markdown stack

**Testing:** test-after (dead-code removal + frontend rendering; a characterization guard plus
typecheck/build/bundle verification, per the tdd frontend exemption).

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a characterization test/story asserting the LIVE reasoning path renders through
     `MarkdownBody` (the `marked` stack) via `chat/reasoning-trace.tsx`, so the prune is proven not
     to touch live rendering.
  2. GREEN: Delete `assistant-ui/thread.tsx`, `assistant-ui/markdown-text-lazy.tsx`,
     `assistant-ui/markdown-text.tsx`.
  3. GREEN: Trim `assistant-ui/reasoning.tsx` - remove the `MarkdownText` import (`:16`),
     `ReasoningImpl` (`:315`), the `Reasoning` memo + `displayName` (`:351-352`), the `Reasoning`
     export (`:355`), and the now-unused `ReasoningMessagePartComponent` type import (`:15`); KEEP
     `ReasoningGroup`/`reasoningVariants`.
  4. GREEN: Remove `remark-gfm` from `apps/web/package.json` entirely; reduce
     `@assistant-ui/react-markdown` to a type-only dependency (the one `SyntaxHighlighterProps` type
     in `diff-viewer.tsx:4`).
  5. REFACTOR: Confirm `preload-on-idle.ts` stays (still used by `diff-viewer-lazy.tsx`); verify the
     `marked`-stack render path is untouched.
  6. Verify: `pnpm --filter web typecheck`, `pnpm --filter web build`, and a bundle check that the
     `markdown-text`/`remark-gfm` chunk no longer ships.

### M2: Running-tool elapsed clock

**Testing:** test-first for the projector fold (behavior-bearing), test-after for the component
prop-threading (frontend rendering).

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. Seams under test: the `transcript.ts` `tool.started` fold that builds `ToolMessage`.
  2. RED: Add a failing projector test asserting a `tool.started` event yields a `ToolMessage` whose
     `startedAt` equals `Date.parse(event.createdAt)`, and that a malformed `createdAt` leaves
     `startedAt` undefined (mirror the `InlineAgent.startedAt` `NaN` guard).
  3. GREEN: Add `startedAt?: number` to `ToolMessage` (`transcript.ts:63`, documented like
     `InlineAgent.startedAt` at `:178`); populate it in the `tool.started` fold (`:1039-1046`) via
     `Date.parse(event.createdAt)` with the `Number.isNaN` guard.
  4. GREEN: Thread `startedAt` through `chat/tool-message.tsx` → `StatusAwareToolRendererProps` →
     the running-branch `ActionShimmer` at `status-aware-tool-renderer.tsx:70`, passing it only
     while running (mirror `running ? agent.startedAt : undefined` from
     `inline-agent-row.tsx:54`).
  5. REFACTOR: De-duplicate the `Date.parse(createdAt)`+guard against the `InlineAgent` fold if a
     shared helper reads cleaner.
  6. Verify: a story/snapshot showing a running tool row rendering the elapsed meta; completed rows
     unaffected.

### M3: assistant-ui dependency governance

**Testing:** test-after (config + docs + tooling, with the render smoke tests as the durable
deliverable).

- **Dependencies:** none
- **Effort:** S-M
- **Tasks:**
  1. GREEN: Pin `@assistant-ui/react` and `@assistant-ui/react-markdown` to exact versions in
     `apps/web/package.json` (drop the carets); update the lockfile.
  2. RED: Add render smoke tests asserting the reasoning-trace row and the tool diff /
     multi-edit-diff viewers render their expected structure - the tests that must survive a future
     assistant-ui bump.
  3. GREEN: Add the stability-ledger table to `CONTEXT.md`: every live assistant-ui import
     (`useScrollLock` at `use-collapsible-disclosure.ts:3`, the type-only
     `ReasoningMessagePartComponent`/`ToolCallMessagePartStatus`, `SyntaxHighlighterProps`, the
     vendored components) with its stability tier and pin.
  4. GREEN: Add an `assistant-ui add --dry` drift check (script or documented command) over the
     vendored `components/assistant-ui/` files so upstream changes to a vendored component are
     visible at review time.
  5. REFACTOR: Cross-link the ledger from the vendored dir (a short module comment or README pointer)
     so the next editor finds the policy.
  6. Verify: `pnpm --filter web test` (smoke tests green), `pnpm install` clean against the exact
     pins.

## 4. Non-Goals

- No structured MCP result rows (D-003).
- No content-visibility / paint-skipping / virtualization work - that surface belongs to 58.4's
  successor work (D-004).
- No change to any wire contract, host event, or the durable log (D-005); item 2 sources its
  timestamp from the existing envelope field.
- No migration onto an assistant-ui runtime; no adapter work (that is the audit's Track B,
  research-only).
- No broad chat-UI redesign.

## 5. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| A "dead" file in the prune is actually reachable | high | low | M1 RED characterization + typecheck/build/bundle gate; the zero-importer trace is recorded in section 2 | impl |
| `@assistant-ui/react-markdown` cannot cleanly drop to type-only | medium | low | Keep it as a type-only/dev dependency for the single `SyntaxHighlighterProps` use rather than deleting | impl |
| Elapsed clock reads a bad `createdAt` and renders NaN | medium | low | M2 RED covers the malformed-timestamp guard, mirroring the shipped `InlineAgent` guard | impl |
| Exact pins block a needed transitive security bump | low | low | Governance ledger documents the pin + tier so a deliberate bump + smoke-test run is the update path | impl |
| Render smoke tests are too brittle (assert styling not structure) | medium | medium | Assert structural/role output, not class names; that is the point of the version-bump guard | impl |

## 6. Validation Commands

```sh
pnpm --filter web typecheck
pnpm --filter web test
pnpm --filter web build
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "58.6.1-assistant-ui-audit-followups"
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts check-convergence --plan "58.6.1-assistant-ui-audit-followups" --streak 3
```

## 7. Decisions

Canonical decisions are in `plan.db`.

- D-001: scope = audit items 1-3; items 4 and 5 dropped.
- D-002: numbered 58.6.1 (decimal off 58.6).
- D-003: item 4 (structured MCP rows) dropped - needs a contract change, not presentational.
- D-004: item 5 (content-visibility) dropped - superseded by shipped 58.4.
- D-005: item 3 sources start time from `event.createdAt`; no wire change.
- D-006: item 2 prune scope (delete the dead stack, keep `ReasoningGroup`).
- D-007: item 1 exact pins + `CONTEXT.md` ledger + drift check + render smoke tests.
- D-008: no downstream plan accommodation (48/49/50/57 unrelated).
