# Inline-Agent Compact Exemption - Implementation Plan

## 0. Hard Dependencies

- [x] Existing inline-agent delegation rendering (plan 09.4) - `InlineAgentRow`/`InlineAgentGroup` already render one clickable row per agent in the full view, and the live child-agent detail takeover (M6) already opens on click. This plan only changes which renderer compact mode selects; it adds no new surface.
- [x] Existing compact-mode discriminator - `staysFullInCompact`/`isCompactEligible`/`compactDisplayFor` already centralize the compact-vs-full decision in `apps/web/src/components/chat/compact-display.ts`.
- [ ] Downstream accommodation - none. No plan numbered higher than 58.1 exists; plan 58 is in flight on `feat/58-project-sidebar-sessions` and is skipped (live branch). <!-- D-002 -->

## 1. Architecture

Inline-agent delegations (`delegate_inline`) become **exempt from compact mode**: compact mode renders them through the same `InlineAgentGroup` path the normal view uses - one clickable `InlineAgentRow` per child - instead of collapsing the whole delegation to a single `CompactRow` summary. The change is a one-line discriminator flip plus removal of the now-dead compact-inline-agent code paths. <!-- D-001 -->

### Current State

- `apps/web/src/components/chat/compact-display.ts` - `staysFullInCompact()` returns `true` only for `user` and assistant-with-text; `inlineAgent` is compact-eligible. `compactDisplayFor()` routes `inlineAgent` to `inlineAgentCompact()`, which emits ONE `CompactDisplay` per delegation message: a single agent renders as one line; multiple agents collapse to primary `"N agents"` with a truncated name list. `compactInlineAgentAction()` returns a click handler only when `agents.length === 1` - parallel delegations are non-clickable.
- `apps/web/src/components/chat/virtual-transcript.tsx` - compact mode renders compact-eligible messages through `CompactRow` using `isCompactEligible(row.message)`.
- `apps/web/src/components/chat/transcript-row-view.tsx` - the full-view `inlineAgent` case renders `<InlineAgentGroup agents onOpen>` (one `InlineAgentRow` per agent, each clickable -> live child transcript). `compactRowAction()` has a dedicated `inlineAgent` branch via `compactInlineAgentAction`.
- `apps/web/src/components/chat/inline-agent-row.tsx` - `InlineAgentRow`/`InlineAgentGroup` render the `◆ agent · model · thinking · (elapsed · ↓ tokens)` contract; a lone child renders as a bare row, >=4 agents auto-drop the thinking cell. Unchanged by this plan.

### Target Shape

- `staysFullInCompact()` returns `true` for `kind === "inlineAgent"`, so `isCompactEligible(inlineAgent)` is `false` and compact mode renders the delegation via the full `InlineAgentGroup` path - byte-identical to the normal view. <!-- D-001 -->
- `inlineAgentCompact`, `compactInlineAgentAction`, the `inlineAgent` case in `compactDisplayFor`, and the `inlineAgent` branch in `compactRowAction` are removed, along with their tests. <!-- D-004 -->
- `InlineAgentGroup`'s auto-drop-thinking-cell at >=4 agents is preserved. <!-- D-003 -->
- Background `delegation` blocks are unchanged. <!-- D-002 -->

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| One clickable subagent per line in compact mode | Matches the normal view exactly; no compact-specific row variant. |
| Click-to-open-child preserved | Each row still opens the live child-agent detail takeover (M6); never regress to a non-clickable summary. |
| No compact-spacing regression | A full `inlineAgent` block sitting among compact rows must not break `compactLeadingGaps`/`compactAbove` spacing. |
| Dead code removed | No unreachable compact-inline-agent branches left to drift. |

### Boundaries

- `apps/web/src/components/chat/compact-display.ts` owns the exemption (`staysFullInCompact`) and loses `inlineAgentCompact` + the `inlineAgent` case in `compactDisplayFor`.
- `apps/web/src/components/chat/transcript-row-view.tsx` loses `compactInlineAgentAction` and the `inlineAgent` branch in `compactRowAction`; the full-view `inlineAgent` case becomes the sole renderer.
- `apps/web/src/components/chat/inline-agent-row.tsx` is unchanged.
- `apps/web/src/components/chat/virtual-transcript.tsx` needs no change (it already delegates to the full renderer for non-compact-eligible messages).

### Observability

Not applicable. This is a pure web presentation change with no runtime/provider/transport behavior; the existing inline-agent-row tests and Storybook stories are the verification surface.

---

## Phases

### Phase 1: Inline-Agent Compact Exemption

**Goal:** Compact mode renders inline-agent delegations as one clickable row per agent, identical to the normal view, with no dead compact-inline-agent code left behind.

**Gate from previous:** none.

#### M1: Exempt inline-agent from compact mode

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add a `compact-display` test asserting `staysFullInCompact` returns `true` for an `inlineAgent` message and `isCompactEligible(inlineAgent)` returns `false`.
  2. GREEN: Add `kind === "inlineAgent"` to `staysFullInCompact` so the discriminator exempts inline-agent delegations.
  3. RED: Add a `virtual-transcript`/`transcript-row-view` test that, in compact mode, an inline-agent delegation with multiple children renders one `InlineAgentRow` per child (each clickable via `onOpen`), not a single `CompactRow` summary.
  4. GREEN: Confirm the compact rendering branch now routes `inlineAgent` through the full `InlineAgentGroup` path (via the exemption); no extra wiring needed.

#### M2: Remove dead compact-inline-agent code

- **Dependencies:** M1
- **Effort:** S
- **Tasks:**
  1. RED: Add a characterization assertion (grep/import test) that `inlineAgentCompact`, `compactInlineAgentAction`, the `inlineAgent` case in `compactDisplayFor`, and the `inlineAgent` branch in `compactRowAction` no longer exist.
  2. GREEN: Delete those four code paths and their dedicated tests.
  3. REFACTOR: Collapse any compact-display test scaffolding that only existed for the inline-agent case; ensure `compactDisplayFor` has no `inlineAgent` arm.

#### M3: Spacing and visual verification

- **Dependencies:** M2
- **Effort:** S
- **Tasks:**
  1. RED: Add a spacing test that a full `inlineAgent` block adjacent to compact rows (tool/user) produces correct `compactLeadingGaps`/`compactAbove` boundaries - no doubled or missing gaps.
  2. GREEN: Adjust compact-spacing logic only if the exemption introduces a gap regression; otherwise leave as-is.
  3. RED: Add a Storybook story for inline-agent rows in compact mode showing one clickable subagent per line (single + parallel >=4) matching the normal-view story.
  4. GREEN: Wire the story to the compact-mode flag so it exercises the exempted path.
  5. REFACTOR: Share fixtures between the compact-mode and normal-view inline-agent stories so the two cannot drift.

### Gate 1 (done)

- [ ] All `web` project tests green (`compact-display`, `virtual-transcript`, `transcript-row-view`, `inline-agent-row`).
- [ ] Storybook: compact-mode inline-agent story shows one clickable row per agent, identical to the normal view.
- [ ] No references to `inlineAgentCompact`/`compactInlineAgentAction` remain.

---

## Non-Goals

- Changing background `delegation` block rendering (already its own `ToneAlert` block). <!-- D-002 -->
- Changing `InlineAgentGroup`'s >=4 auto-drop-thinking-cell behavior. <!-- D-003 -->
- Changing the live child-agent detail takeover (M6) or the `delegated.to` event shape.
- Touching the turn-status "delegating to X…" headline logic.

---

## Decisions

Canonical decisions are in `.plans/58.1-inline-agent-compact-exemption/plan.db`. Query with:

```bash
npx tsx ~/.agents/skills/planner/scripts/plan-db.ts query-decisions --plan "58.1-inline-agent-compact-exemption"
```

Key decisions: D-001 (exemption), D-002 (inline-only scope), D-003 (keep >=4 auto-compact), D-004 (remove dead code).
