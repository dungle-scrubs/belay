# Ghosted Reasoning Rendering - Implementation Plan

## 0. Hard Dependencies

- Existing `assistant.thinking` protocol event and transcript reducer path.
- Existing `TranscriptRowView` `showThinking` gate.
- Existing `ThinkingMessage` component in `apps/web/src/components/chat/message.tsx`.
- Existing `MarkdownBody` rendering for reasoning text.
- Existing assistant-ui `ReasoningGroup` / disclosure primitives in `apps/web/src/components/assistant-ui/reasoning.tsx`.
- Existing `.plans/05-compact-transcript-layout` as the future compact-mode integration boundary.
- Coordinate with `.plans/09.1-mid-turn-model-switch` (lands first): it adds a `model.switched` inline marker row that renders a reasoning-level delta (`X (high) -> X (medium)`) and shares `apps/web/src/components/chat/transcript-row-view.tsx`. That marker is owned by 09.1 and is distinct from this plan's ghosted reasoning trace.
- `09.2-web-browser-test-suite` (lands first) - "streaming behavior must not yank transcript scroll" is exactly 09.2 Lane B's mid-stream-no-yank assertion; keep it green, and regenerate Lane A baselines for the reasoning story states (hidden/collapsed/expanded/streaming/narrow). <!-- D-005 -->

## 1. Architecture

Trevor already separates model thinking from answer text: the host emits `assistant.thinking`, the transcript reducer appends it to `AssistantMessage.thinking`, and `TranscriptRowView` renders it only when `showThinking` is enabled. This plan keeps that data path and replaces the simple `ThinkingMessage` visual treatment with a ghosted reasoning surface based on the assistant-ui reasoning pattern.

The first implementation target is still the current `thinking` string, not a new reasoning-part protocol. If a provider later emits structured reasoning parts, those can be adapted into the same presentation component without changing this plan's initial boundary.

The desired behavior is: reasoning reads as secondary, ghosted scaffolding; it can shimmer/open while streaming; it collapses cleanly after completion unless the user manually expands it; it respects the existing `show thinking` toggle; and compact transcript mode can later collapse it into a one-line item.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Preserve `assistant.thinking` data path | No protocol migration is required for the first cut |
| Preserve `showThinking` as the visibility gate | User preference still controls whether reasoning appears |
| Ghosted styling stays visually secondary | Reasoning never competes with the final answer |
| Streaming behavior must not yank transcript scroll | Auto-open/auto-collapse must respect existing virtualized scrolling |
| Compact-mode behavior is documented but not implemented here | Plan 27 owns global compact transcript layout |

### Boundaries

- `transcript.ts` remains the reducer boundary for `assistant.thinking`.
- `TranscriptRowView` remains the gate that decides whether thinking appears.
- A renamed or replacement `ThinkingMessage`/`ReasoningTrace` component owns presentation.
- assistant-ui `ReasoningGroup` is reference/local implementation material, not a mandate to migrate the whole transcript to assistant-ui message parts.
- Compact transcript one-line rendering is an integration contract with `.plans/05-compact-transcript-layout`.
- The `model.switched` reasoning-level marker is owned by `.plans/09.1-mid-turn-model-switch`, not by this reasoning surface. <!-- D-004 -->

### Observability

No host/runtime observability is required. DOM tests and Storybook states should prove hidden/collapsed/expanded/streaming behavior, reduced-motion behavior, and scroll stability.

## 2. Phases

### Phase 1: Reasoning Surface Primitive

**Goal:** The existing thinking trace renders through a reusable ghosted reasoning surface.

#### M1: Component Shape and States

- **Dependencies:** hard dependencies
- **Effort:** M
- **Tasks:**
  1. RED: Add component tests for collapsed, expanded, empty, long, and markdown-rich reasoning content.
  2. GREEN: Replace or wrap `ThinkingMessage` with a ghosted reasoning component using Trevor tokens and assistant-ui reasoning behavior.
  3. RED: Add tests for manual toggle persistence within a mounted message.
  4. GREEN: Keep collapsed state compact and expanded state capped with internal scroll/fade for long content.
  5. RED: Verify copy/source or text selection still works in expanded content.
  6. REFACTOR: Rename local component only if it improves clarity without touching protocol names.

#### M2: Streaming Behavior

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add tests/stories for active streaming reasoning with shimmer/active trigger state.
  2. GREEN: Auto-open while reasoning is actively streaming when `showThinking` is enabled.
  3. RED: Add tests for auto-collapse after streaming completes unless the user manually toggled.
  4. GREEN: Preserve manual user choice over automatic streaming state once the user toggles.
  5. RED: Verify reduced-motion disables shimmer/animated distractions.
  6. REFACTOR: Keep streaming state derivation local to transcript rendering, not protocol-breaking.

### Phase 2: Transcript Integration

**Goal:** Assistant rows use the ghosted reasoning surface without changing answer layout or scroll behavior.

#### M3: Transcript Row Wiring

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Extend `transcript-row-view.test.tsx` for `showThinking=true`, `showThinking=false`, streaming, done, interrupted, and error rows.
  2. GREEN: Wire assistant rows to the new reasoning surface while preserving answer text and meta placement.
  3. RED: Verify rows with no answer text still show loading/thinking correctly.
  4. GREEN: Preserve `WorkingIndicator` fallback when no thinking text has arrived.
  5. RED: Verify virtualized row measurement stabilizes when reasoning expands/collapses.
  6. REFACTOR: Avoid duplicating reasoning rendering between "thinking only" and "answer plus thinking" assistant rows.

#### M4: Storybook Coverage

- **Dependencies:** M3
- **Effort:** S
- **Tasks:**
  1. RED: Add Storybook states for hidden, collapsed, expanded, streaming, long, markdown-rich, interrupted/error-adjacent, and narrow viewport.
  2. GREEN: Make the visual treatment ghosted/muted while keeping trigger and chevron readable.
  3. RED: Add dark/high-contrast and reduced-motion visual checks.
  4. GREEN: Ensure text does not overlap inside compact row widths or long reasoning lines.
  5. REFACTOR: Keep stories on production components rather than detached demo-only markup.

### Phase 3: Compact Layout and Accessibility Contract

**Goal:** Reasoning has a clear contract with compact transcript mode and is accessible when shown.

#### M5: Compact and Accessibility

- **Dependencies:** M4
- **Effort:** S
- **Tasks:**
  1. RED: Document compact transcript behavior: reasoning collapses to one line with status/count/active indicator.
  2. GREEN: Add props or view-model affordances needed by plan 27 without implementing compact mode here.
  3. RED: Add accessibility tests for trigger label, expanded region semantics, keyboard toggle, and busy state while streaming.
  4. GREEN: Preserve focus order and Escape behavior expectations from broader shortcut plans.
  5. REFACTOR: Keep the visible label stable as `thinking` unless product copy is deliberately changed everywhere.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Auto-open reasoning disrupts transcript scrolling | high | medium | Test virtualized row measurement and scroll-follow behavior | web |
| Reasoning competes visually with final answer | medium | medium | Use ghosted/muted variant and restrained trigger copy | web |
| Manual toggle fights streaming auto-state | medium | medium | Use assistant-ui-style user-owned toggle after first manual action | web |
| Future structured reasoning parts conflict with thinking string | medium | low | Keep first cut on current string and leave adapter seam documented | web |

## 4. Escape Hatches

1. **If streaming auto-open is unstable:** keep reasoning collapsed while streaming and only shimmer the trigger.
2. **If long reasoning harms virtualization:** cap expanded content height with internal scroll and disable auto-open for very long traces.
3. **If assistant-ui primitive conflicts with current CSS/runtime:** copy the behavior pattern into a Trevor-native component instead of importing the primitive directly.

## 5. Progress Report Accounting

Progress lives in `.plans/35-ghosted-reasoning-rendering/progress-report.md`. Count only active unchecked implementation tasks as blockers. Do not mark streaming behavior complete unless manual toggle precedence and reduced-motion behavior are covered.

Before resuming implementation or declaring convergence, run:

```bash
mise x node@22 -- npx tsx /Users/kevin/dev/dotfiles/agents/.agents/skills/planner/scripts/plan-db.ts check-progress --plan "35-ghosted-reasoning-rendering"
```

## 6. Validation Commands

```bash
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/transcript-row-view.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/chat/message.test.tsx
pnpm --filter @trevor/web test -- --project web apps/web/src/components/assistant-ui/use-collapsible-disclosure.test.tsx
pnpm --filter @trevor/web storybook
pnpm test -- --project web
```

## 7. Decisions

Canonical decisions live in `.plans/35-ghosted-reasoning-rendering/plan.db`.
