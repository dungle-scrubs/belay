# Tool Detail Takeover - Implementation Plan

## 0. Hard Dependencies

- [ ] `07-keyboard-shortcuts` - frontmost-surface focus guards and Escape ownership must be settled so detail-view Escape returns to chat without leaking to background surfaces.
- [ ] `05-compact-transcript-layout` - compact rows provide a consistent entry point and detail eligibility language for dense transcript items.
- [x] Existing model chooser transcript-takeover pattern from D-065.
- [x] Existing archive-browser plan pattern in `.plans/04-archive-browser-and-delete` - management/detail surfaces replace the transcript and use a top-left back arrow.
- [x] Existing transcript/tool rendering boundary - transcript tool rows already carry args, status, result, and renderer-specific output.

## 1. Architecture

The tool detail takeover is a Storybook-first detail surface for transcript items that have deeper information. Selecting a detail-eligible transcript row replaces the chat transcript/prompt area with a focused detail view, using the same pattern as the model chooser and archive browser: top-left back arrow, no overlay, no modal, and sidebars can remain visible where layout allows.

Escape returns to chat from the detail view. That Escape behavior must respect the frontmost-surface keyboard policy: if the detail view is active, Escape closes it; it must not also cancel a turn, clear a modal behind it, edit the composer, or interact with a hidden transcript.

The detail view is live when the underlying tool is live. A running bash command, streaming MCP tool, web/docs fetch, or any future streamable tool should update the detail view as events arrive. Completed tools show full arguments, status, timing if available, capped/raw output affordances, rendered output, errors, and related artifacts.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| Storybook first | Tool detail shells and per-tool states are reviewed before live app wiring. |
| Transcript takeover | Detail replaces the chat transcript/prompt area with a top-left back arrow. |
| Escape returns to chat | Escape closes the detail view through the frontmost-surface keyboard policy. |
| Live updates | Running/streaming tools update the detail view without reopening or resetting scroll. |
| Detail-eligible only | Not every row needs detail; user prompts and ordinary final responses are not first-cut targets. |
| Tool-by-tool expansion | Start with generic detail fallback, then add richer per-tool detail panels. |

### Boundaries

- `apps/web` owns the detail takeover shell, Storybook fixtures, routing from transcript rows, live rendering, Escape/back behavior, and focus management.
- Transcript row display owns the detail entry affordance, not the detail body.
- Tool detail adapters own per-tool rendering for bash, read, write, edit, multi_edit, grep/glob, web/docs fetch, MCP, session recall, and unknown tools.
- Host/session protocol changes should be minimal. If current tool events lack streaming chunks, timing, or metadata needed for live detail, add typed fields/events at the tool boundary rather than parsing rendered transcript text.

### Observability

Tool detail exists partly to improve user-visible observability. It should expose:

- args and sanitized command/request metadata,
- running/done/error/aborted state,
- streaming output or progress when available,
- start/end timing when available,
- output caps and truncation indicators,
- links or refs to artifacts/blobs when relevant,
- structured error/failure class where available.

The surface must not display secrets that are intentionally redacted from normal tool output.

## 2. Phases

### Phase 1: Storybook Detail Shell

**Goal:** The takeover shell and generic detail shape are reviewable before live app wiring.

**Gate from previous:** Compact row/detail eligibility language is available, or generic transcript-row entry fixtures can stand in during planning.

#### M1: Detail Eligibility Contract

- **Dependencies:** none
- **Effort:** S
- **Tasks:**
  1. RED: Add tests or fixture assertions for detail eligibility on bash, read, write, edit, multi_edit, grep, glob, web search, docs/web fetch, MCP, session recall, shell lane, and unknown tool rows.
  2. GREEN: Define a `ToolDetailModel` contract with id, source row key, tool name, status, args, result/output, error, timing, stream/progress, artifacts, and redaction metadata where available.
  3. RED: Add tests proving user prompts and ordinary final assistant responses are not first-cut detail targets.
  4. GREEN: Implement a pure projection from transcript tool rows/events to generic detail models.
  5. REFACTOR: Keep detail projection independent from compact row summaries.

#### M2: Takeover Shell Stories

- **Dependencies:** M1
- **Effort:** M
- **Tasks:**
  1. RED: Add Storybook stories for generic detail open, running, completed, error, aborted, empty/unavailable, narrow width, both sidebars visible, and long-output states.
  2. GREEN: Build the detail takeover shell with top-left back arrow and stable header/status area.
  3. RED: Add interaction tests for back arrow and Escape returning to chat.
  4. GREEN: Implement focus return to the source transcript row when closing where possible.
  5. REFACTOR: Reuse takeover shell patterns only where already clean; do not prematurely force model chooser/archive/detail into one abstraction.

### Gate 1->2

- [ ] Storybook shell states are reviewed.
- [ ] Escape and back-arrow behavior are covered in component tests.
- [ ] Detail view clearly reads as a focused inspection surface, not normal chat.

### Phase 2: Tool-Specific Detail Adapters

**Goal:** High-value tools show meaningful deeper information instead of generic raw text only.

**Gate from previous:** Generic detail shell approved.

#### M3: Filesystem and Shell Details

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add detail adapter tests for bash, read, write, edit, and multi_edit.
  2. GREEN: Show bash command, cwd, status, streaming output, exit/error state, truncation, and timing when available.
  3. GREEN: Show read path/range, rendered snippet/full output boundary, and open-in-editor action where available.
  4. GREEN: Show write/edit/multi_edit file paths, diff/full patch detail, result, and failures.
  5. REFACTOR: Share file/path/open-in-editor detail primitives across filesystem tools.

#### M4: Search, Web, Docs, MCP, and Unknown Details

- **Dependencies:** M2
- **Effort:** L
- **Tasks:**
  1. RED: Add detail adapter tests for grep, glob, web search, docs/web fetch, MCP, session recall, and unknown tools.
  2. GREEN: Show search query/pattern, scope, match counts, result groups, truncation, and errors.
  3. GREEN: Show web/docs request metadata, normalized results, fetch status, citations/URLs, and sanitized errors.
  4. GREEN: Show MCP server/tool name, args summary, streaming/progress output where available, result, and failure details.
  5. REFACTOR: Keep unknown-tool fallback useful without requiring tool-specific code.

### Gate 2->3

- [ ] Filesystem, shell, search, web/docs, MCP, and unknown detail stories exist.
- [ ] Running/streaming fixtures update in place.
- [ ] Redaction and truncation indicators are visible where applicable.

### Phase 3: Live App Integration

**Goal:** Detail-eligible transcript items can open a live takeover view that keeps updating.

**Gate from previous:** Tool-specific stories and tests pass.

#### M5: Open/Close Routing

- **Dependencies:** M2, `07-keyboard-shortcuts`
- **Effort:** M
- **Tasks:**
  1. RED: Add app tests for opening detail from regular transcript rows and compact rows.
  2. GREEN: Add the detail-open action to eligible rows without cluttering non-eligible rows.
  3. RED: Add tests proving only one transcript takeover is active at a time across model chooser, archive browser, and tool detail.
  4. GREEN: Route detail takeover through the same center-column takeover slot as other takeover surfaces.
  5. REFACTOR: Keep source row identity stable so close can restore focus and scroll.

#### M6: Live Streaming Detail

- **Dependencies:** M5
- **Effort:** L
- **Tasks:**
  1. RED: Add tests for a running bash/tool detail view receiving incremental updates.
  2. GREEN: Wire live session events into the open detail model without requiring transcript re-open.
  3. RED: Add tests for tool completion, error, abort, and late-arriving updates while detail is open.
  4. GREEN: Keep detail status/output synchronized with transcript rows.
  5. REFACTOR: Ensure detail state is derived from session events/read models, not copied stale local snapshots.

### Gate 3->4

- [ ] Live detail opens from regular and compact transcript rows.
- [ ] Escape/back returns to chat and does not trigger background actions.
- [ ] Running tool detail updates live through completion/error/abort.

### Phase 4: Validation

**Goal:** The detail view is tested across interaction, layout, and live event behavior.

**Gate from previous:** Live integration complete.

#### M7: Verification Pass

- **Dependencies:** M6
- **Effort:** M
- **Tasks:**
  1. RED: Add hermetic e2e coverage for opening detail on a running fake tool and watching it complete.
  2. GREEN: Make e2e pass with deterministic fake provider/tool events.
  3. RED: Add manual EZE checklist for bash, read/write/edit, web/docs, MCP if configured, Escape/back, and narrow-width behavior.
  4. GREEN: Verify Storybook stories at desktop and narrow widths.
  5. REFACTOR: Remove any duplicate detail logic from individual transcript row renderers.

### Gate 4

- [ ] Unit, web, integration, and hermetic e2e tests pass for tool-detail behavior.
- [ ] Storybook detail view review is approved.
- [ ] Manual EZE confirms live streaming detail and Escape/back behavior.

## 3. Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| Detail view shows stale tool data | high | medium | Derive from session events/read models and test late updates. | Web |
| Escape conflicts with cancel/Vim/modal behavior | high | medium | Depend on keyboard focus guards and test frontmost surface routing. | Web |
| Tool-specific adapters sprawl | medium | high | Generic fallback first, per-tool adapters only for high-value detail. | Web |
| Sensitive args/results leak | high | low | Respect existing redaction and add detail-specific redaction tests. | Host/Web |
| Takeover surfaces conflict | medium | medium | Single center-column takeover slot; tests across chooser/archive/detail. | Web |

## 4. Escape Hatches

1. **If streaming metadata is missing:** ship completed-tool detail first and mark live-streaming support unavailable per tool until the protocol adds chunks/progress.
2. **If Escape routing is not ready:** keep detail view Storybook-only or back-arrow-only until `07-keyboard-shortcuts` lands.
3. **If tool adapters are too broad:** ship generic detail fallback plus bash/read/write first, then add web/docs/MCP in later slices.

## 5. Progress Report Accounting

The progress report is `.plans/08-tool-detail-takeover/progress-report.md`. It tracks only the transcript-item detail takeover surface. It does not track compact row rendering except as an entry-point dependency, and it does not track artifact-panel/Lucid document viewing.

## 6. Validation Commands

```bash
pnpm --filter @trevor/web storybook
pnpm --filter @trevor/web test -- transcript-row-view virtual-transcript tool
pnpm --filter @trevor/web test
pnpm test -- --project e2e
pnpm typecheck
pnpm biome check
```

## 7. Decisions

Canonical decisions are in `.plans/08-tool-detail-takeover/plan.db`.

