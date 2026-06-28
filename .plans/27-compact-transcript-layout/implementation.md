# Compact Transcript Layout - Implementation Plan

## 0. Hard Dependencies

- [x] Existing transcript projection and rendering boundaries - `apps/web/src/transcript.ts`, `apps/web/src/transcript-rows.ts`, `VirtualTranscript`, and `TranscriptRowView` already define semantic rows and rendering slots.
- [x] Existing Storybook coverage for chat/tool components - tool stories already exercise many tool renderers and can host compact variants.

## 1. Architecture

Compact transcript layout is a user-toggleable display mode for the chat transcript. In compact mode, user prompts and final assistant responses keep their normal readable rendering. Everything else becomes a one-line row with a consistent UX: thinking, active tool use, completed tool use, errors, command results, concurrent read batches, shell lane output, recovery/status events, and future tool-like transcript items.

The compact mode is presentation-only. It does not change the durable session log, provider prompt history, compaction, recall, task state, or tool execution. The same semantic transcript rows should render in either regular or compact form.

The work is Storybook-first. The first reviewable artifact is a transcript frame showing the same fixture conversation in regular and compact modes, with enough tool variety to judge density, icons, progress indicators, error states, truncation, and row actions.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Storybook first | Compact row states are reviewed before live app wiring. |
| Toggle anytime | The user can switch compact mode while a turn or tool is running. |
| Presentation-only | No session events, model-visible history, or tool state change. |
| Keep prompts/responses readable | User prompts and final assistant responses stay normal by default. |
| One-line non-primary rows | Thinking, tools, status, command, and diagnostic rows collapse to stable single-line rows. |
| Consistent row UX | Every compact row has a shared icon/status/title/summary/action/progress structure. |

### Boundaries

- `transcript-rows.ts` continues to own semantic row grouping. Compact mode should not fork transcript semantics unless a small display projection is needed.
- `VirtualTranscript` owns row sizing and virtualization estimates for regular vs compact rows.
- `TranscriptRowView` or a nearby adapter owns choosing regular vs compact rendering.
- Tool-specific components may expose compact summaries, but the shared compact row chrome owns layout, status icon, loader/progress slot, and action affordances.
- Preference storage is intentionally unspecified in the first slice. If persistence is desired, it should reuse the existing Trevor config/state rules instead of inventing storage.

### Observability

This is a UI projection feature. It needs no new host telemetry. Useful diagnostics are frontend-only:

- Storybook fixtures for row types and live/running transitions.
- Tests proving toggling compact mode does not mutate transcript data or reset scroll incorrectly.
- Optional debug labels in tests for row type/status, not visible production text.

## 2. Phases

### Phase 1: Storybook Compact Row Contract

**Goal:** The compact row language is reviewable with representative transcript fixtures before app wiring.

**Gate from previous:** Existing transcript/tool stories can be reused or extended.

#### M1: Compact Row Inventory

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add fixture coverage for user prompt, final assistant response, thinking-only segment, streaming assistant segment, running tool, completed tool, failed tool, aborted tool, concurrent read batch, shell lane, recovery/status row, image result, and session recall/web search rows.
  2. GREEN: Define a compact display contract with row kind, icon, status, primary label, secondary summary, action slot, progress/loader slot, and detail eligibility.
  3. RED: Add tests proving user prompts and final assistant responses are not compacted by default.
  4. GREEN: Implement pure row classification for compact eligibility.
  5. REFACTOR: Keep compact eligibility separate from durable transcript semantics.

#### M2: Shared Compact Row Component

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for compact row visual states: running, done, error, aborted, expandable/detail-eligible, no-detail, long path, long command, narrow width, and high-density lists.
  2. GREEN: Build the shared one-line compact row chrome.
  3. RED: Add interaction tests for row actions and accessible labels without layout shifts.
  4. GREEN: Implement stable sizing, truncation, loader/progress indicators, and consistent hover/focus styles.
  5. REFACTOR: Move repeated status/icon mapping into one display helper if existing helpers are insufficient.

### Gate 1->2

- [ ] Storybook compact row states are reviewed at desktop and narrow widths.
- [ ] Long labels and paths do not overflow or resize rows.
- [ ] The compact language is consistent across non-primary row types.

### Phase 2: Transcript-Level Compact Mode

**Goal:** A full transcript fixture can toggle between regular and compact display without changing transcript state.

**Gate from previous:** Compact row component approved.

#### M3: Transcript Fixture and Toggle

- **Dependencies:** M2
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for full transcript regular mode, compact mode, and live-running compact mode using the same fixture data.
  2. GREEN: Add a transcript-level compact-mode prop that switches eligible rows to compact rendering.
  3. RED: Add tests proving toggling compact mode preserves semantic row keys and does not mutate messages.
  4. GREEN: Update virtualization estimates for compact rows.
  5. REFACTOR: Keep compact mode out of transcript folding and provider history code.

#### M4: Tool-by-Tool Summaries

- **Dependencies:** M3
- **Effort:** L
- **Tasks:**
  1. RED: Add compact summary tests for bash, read, write, edit, multi_edit, grep, glob, web search, session recall, docs/web fetch, MCP, and unknown tools.
  2. GREEN: Implement compact summaries incrementally, starting with generic fallback and then high-value tool-specific summaries.
  3. RED: Add tests for running/progress states per supported tool type.
  4. GREEN: Render action/progress indicators appropriate to each tool type.
  5. REFACTOR: Keep tool-specific summary logic near tool renderers or a dedicated display registry, not scattered through `TranscriptRowView`.

### Gate 2->3

- [ ] Full transcript Storybook fixture toggles cleanly.
- [ ] Compact rows stay one line across supported tool types.
- [ ] Running tools update compact status without row-height churn.

### Phase 3: Live App Toggle

**Goal:** The user can toggle compact layout at any time in the live app.

**Gate from previous:** Transcript-level compact mode approved.

#### M5: Toggle Surface

- **Dependencies:** M3
- **Effort:** M
- **Tasks:**
  1. RED: Add web tests for toggling compact mode while idle, while streaming assistant text, and while tools are running.
  2. GREEN: Add the compact-layout toggle to the chosen app control surface.
  3. RED: Add tests proving user prompts and final assistant responses remain full rendering in compact mode.
  4. GREEN: Wire compact mode into `PanelHost`/`VirtualTranscript`.
  5. REFACTOR: Keep toggle state local unless a separate decision chooses persistence.

#### M6: Scroll and Accessibility

- **Dependencies:** M5
- **Effort:** M
- **Tasks:**
  1. RED: Add scroll tests for compact toggle at bottom, scrolled up, and during live streaming.
  2. GREEN: Preserve live-bottom behavior and unseen-message state when compact mode changes row heights.
  3. RED: Add keyboard/screen-reader tests for compact rows and row actions.
  4. GREEN: Add accessible names that describe compact row status without verbose transcript duplication.
  5. REFACTOR: Keep compact row focus targets stable and predictable.

### Gate 3

- [ ] Storybook compact transcript review is approved.
- [ ] Web tests cover idle, streaming, tool-running, and scroll states.
- [ ] Compact mode does not mutate transcript semantics or prompt history.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Compact rows hide important errors | high | medium | Error status and detail affordance are always visible; final responses stay readable. | Web |
| Tool-specific summaries sprawl | medium | high | Start with generic fallback and add a small display registry only when duplication appears. | Web |
| Row height changes break scroll-follow | medium | medium | Dedicated scroll tests for toggling at bottom and while scrolled up. | Web |
| Compact mode becomes a data model fork | high | low | Treat as display projection only; tests assert semantic row keys/messages remain unchanged. | Web |

## 4. Escape Hatches

1. **If tool-specific summaries are too broad for first cut:** ship generic compact rows for all tools, then add tool-specific summaries in small follow-up slices.
2. **If live toggle disrupts scroll-follow:** keep compact mode Storybook-only until row measurement and scroll preservation are stable.
3. **If persistence is contentious:** keep toggle state session-local and defer persisted preference to the keyboard/settings plan.

## 5. Progress Report Accounting

The progress report is `.plans/27-compact-transcript-layout/progress-report.md`. It tracks only compact transcript display mode and its Storybook/live toggle. It does not track transcript data compaction, prompt-history compaction, model context reduction, or tool-detail takeover.

## 6. Validation Commands

```bash
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test -- transcript-row-view virtual-transcript tool
pnpm --filter @trevor/web test
pnpm typecheck
pnpm biome check
```

## 7. Decisions

Canonical decisions are in `.plans/27-compact-transcript-layout/plan.db`.

